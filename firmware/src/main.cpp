// =============================================================================
// Pipeline twin - ESP32-S3 node firmware (Arduino framework, PlatformIO).
// One source for both boards; the role is chosen at build time:
//   env:inlet       -> NODE_INLET       P1 (ADS1115 A0), F1 (GPIO 4), pump PWM (GPIO 6)
//   env:downstream  -> NODE_DOWNSTREAM  P2 (A0), P3 (A1), F2 (GPIO 4)
//
// Behaviour on the wire = the device emulator (tools/emulator), which the
// platform was developed against:
//   - MQTT over TLS (project CA), per-device account, retained status + last will
//   - telemetry every intervalMs: window-averaged pressures, pulse-counter flows,
//     signed with HMAC-SHA256 (exact-bytes scheme of docs/data-contract.md)
//   - commands: schema -> device id -> signature -> freshness -> nonce -> execute -> signed ack
// =============================================================================
#include <Adafruit_ADS1X15.h>
#include <Arduino.h>
#include <ArduinoJson.h>
#include <MQTT.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <esp_random.h>
#include <esp_task_wdt.h>
#include <sys/time.h>

#include "config.h"
#include SECRETS_FILE
#include "twin_calib.h"
#include "twin_crypto.h"
#include "twin_protocol.h"
#include "twin_sensors.h"

// ----------------------------------------------------------------- topics
static const char* T_TELEMETRY = "pipeline/v1/" DEVICE_ID "/telemetry";
static const char* T_STATUS = "pipeline/v1/" DEVICE_ID "/status";
static const char* T_CMD = "pipeline/v1/" DEVICE_ID "/cmd";
static const char* T_ACK = "pipeline/v1/" DEVICE_ID "/ack";

// ----------------------------------------------------------------- sensors of this node
#if defined(NODE_INLET)
static const char* const P_NAMES[] = {"P1"};
static const uint8_t P_CHANNELS[] = {CH_P1};
static const int N_P = 1;
static const char* F_NAME = "F1";
static const bool HAS_PUMP = true;
#else
static const char* const P_NAMES[] = {"P2", "P3"};
static const uint8_t P_CHANNELS[] = {CH_P2, CH_P3};
static const int N_P = 2;
static const char* F_NAME = "F2";
static const bool HAS_PUMP = false;
#endif

// ----------------------------------------------------------------- state
static WiFiClientSecure net;
static MQTTClient mqtt(MQTT_BUFFER_SIZE);
static Adafruit_ADS1115 ads;
static bool adsOk = false;
static twin::CalibrationStore calib;
static twin::NonceCache nonces;
static uint8_t deviceKey[32];

static char bootId[9];
static uint32_t seq = 0;
static uint32_t intervalMs = DEFAULT_INTERVAL_MS;
static uint32_t lastPublishMs = 0, lastSampleMs = 0, lastMqttOkMs = 0, lastConnectAttemptMs = 0;
static uint32_t prevPulseTotal = 0;
static bool ntpSynced = false;

static float adcSum[2] = {0, 0};
static uint32_t adcN[2] = {0, 0};

static bool pumpOn = false;
static uint8_t pumpDuty = 100;

// flow meter pulse counter (interrupt)
static volatile uint32_t pulseTotal = 0;
static volatile uint32_t lastPulseUs = 0;

// incoming commands are queued by the MQTT callback and handled in loop()
struct PendingCmd {
    char data[MQTT_BUFFER_SIZE];
    int len;
};
static PendingCmd cmdQueue[4];
static volatile int cmdHead = 0, cmdTail = 0;

// ----------------------------------------------------------------- helpers
static uint64_t nowMs() {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    return (uint64_t)tv.tv_sec * 1000ULL + tv.tv_usec / 1000;
}
static uint32_t rand32() { return esp_random(); }

static void IRAM_ATTR onPulse() {
    uint32_t t = micros();
    if (t - lastPulseUs >= FLOW_DEBOUNCE_US) {  // debounce electrical glitches
        pulseTotal++;
        lastPulseUs = t;
    }
}

static void applyPump() {
    if (!HAS_PUMP) return;
    uint32_t maxDuty = (1u << PUMP_PWM_BITS) - 1;
    uint32_t v = pumpOn ? (uint32_t)pumpDuty * maxDuty / 100 : 0;
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWrite(PIN_PUMP_PWM, v);
#else
    ledcWrite(0, v);
#endif
}

/** Sign `buf` (length n) and publish. Returns false if anything failed. */
static bool publishSigned(const char* topic, char* buf, size_t n, bool retained, int qos) {
    size_t len = twin::signInPlace(buf, n, JSON_BUFFER_SIZE, deviceKey);
    if (!len) return false;
    return mqtt.publish(topic, buf, (int)len, retained, qos);
}

// ----------------------------------------------------------------- network
static void onMqttMessage(MQTTClient*, char topic[], char bytes[], int length) {
    if (strcmp(topic, T_CMD) != 0) return;
    int next = (cmdHead + 1) % 4;
    if (next == cmdTail || length >= MQTT_BUFFER_SIZE) return;  // queue full / too large: drop
    memcpy(cmdQueue[cmdHead].data, bytes, length);
    cmdQueue[cmdHead].len = length;
    cmdHead = next;
}

static void publishStatusOnline() {
    static char buf[JSON_BUFFER_SIZE];
    JsonDocument doc;
    doc["v"] = 1;
    doc["deviceId"] = DEVICE_ID;
    doc["online"] = true;
    doc["ts"] = nowMs();
    doc["bootId"] = bootId;
    doc["fw"] = FW_VERSION;
    doc["reason"] = "boot";
    size_t n = serializeJson(doc, buf, sizeof(buf));
    publishSigned(T_STATUS, buf, n, true, 1);
}

static void ensureConnected() {
    if (WiFi.status() != WL_CONNECTED) return;  // the WiFi stack reconnects by itself
    if (mqtt.connected()) {
        lastMqttOkMs = millis();
        return;
    }
    static bool firstAttempt = true;
    if (!firstAttempt && millis() - lastConnectAttemptMs < 3000) return;  // back-off between attempts
    firstAttempt = false;
    lastConnectAttemptMs = millis();
    Serial.printf("MQTT connecting to %s:%d as %s ...\n", MQTT_HOST, MQTT_PORT, MQTT_USER);
    if (mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS)) {
        Serial.println("MQTT connected (TLS)");
        mqtt.subscribe(T_CMD, 1);
        publishStatusOnline();
        lastMqttOkMs = millis();
    } else {
        Serial.printf("MQTT connect failed: lastError=%d returnCode=%d\n", (int)mqtt.lastError(), (int)mqtt.returnCode());
    }
}

// ----------------------------------------------------------------- telemetry
static void sampleAdc() {
    if (!adsOk) return;
    for (int i = 0; i < N_P; i++) {
        adcSum[i] += ads.readADC_SingleEnded(P_CHANNELS[i]);
        adcN[i]++;
    }
}

static void addPressure(JsonObject sensors, int i) {
    JsonObject o = sensors[P_NAMES[i]].to<JsonObject>();
    if (!adsOk || adcN[i] == 0) {
        o["v"] = nullptr;
        o["raw"] = 0;
        o["q"] = "fault";
    } else {
        twin::PressureReading r = twin::countsToPressure(adcSum[i] / adcN[i], calib.get().pressure[i], calib.get().elec);
        if (r.q == twin::Quality::Ok) o["v"] = serialized(String(r.bar, 3));
        else o["v"] = nullptr;
        o["raw"] = r.raw;
        o["q"] = twin::qualityName(r.q);
    }
    adcSum[i] = 0;
    adcN[i] = 0;
}

static void publishTelemetry() {
    static char buf[JSON_BUFFER_SIZE];
    uint32_t nowM = millis();
    float windowS = (nowM - lastPublishMs) / 1000.0f;
    lastPublishMs = nowM;

    JsonDocument doc;
    char nonce[17];
    twin::randomHex(nonce, 8, rand32);
    doc["v"] = 1;
    doc["deviceId"] = DEVICE_ID;
    doc["bootId"] = bootId;
    doc["seq"] = seq++;
    doc["ts"] = nowMs();
    doc["nonce"] = nonce;
    doc["intervalMs"] = intervalMs;
    JsonObject sensors = doc["sensors"].to<JsonObject>();
    for (int i = 0; i < N_P; i++) addPressure(sensors, i);

    uint32_t total = pulseTotal;  // 32-bit aligned read: atomic on the ESP32
    twin::FlowReading f = twin::pulsesToFlow(total, prevPulseTotal, windowS, calib.get().flowK);
    prevPulseTotal = total;
    JsonObject fo = sensors[F_NAME].to<JsonObject>();
    fo["v"] = serialized(String(f.lpm, 3));
    fo["raw"] = f.rawTotal;
    fo["q"] = "ok";

    if (HAS_PUMP) {
        JsonObject p = doc["actuators"]["pump"].to<JsonObject>();
        p["on"] = pumpOn;
        p["duty"] = pumpDuty;
    }
    JsonObject d = doc["diag"].to<JsonObject>();
    d["uptimeS"] = (uint32_t)(nowM / 1000);
    d["rssi"] = constrain(WiFi.RSSI(), -127, 0);
    d["heapFree"] = ESP.getFreeHeap();
    d["ntpSynced"] = ntpSynced;

    size_t n = serializeJson(doc, buf, sizeof(buf));
    if (calib.rawStreaming()) Serial.printf("RAW %s\n", buf);  // for the calibration tool
    if (!ntpSynced || !mqtt.connected()) return;  // unsynced clock => the platform would reject it
    publishSigned(T_TELEMETRY, buf, n, false, 0);
}

// ----------------------------------------------------------------- commands
static void sendAck(const char* cmdId, const char* status, const char* reason) {
    static char buf[JSON_BUFFER_SIZE];
    JsonDocument doc;
    char nonce[17];
    twin::randomHex(nonce, 8, rand32);
    doc["v"] = 1;
    doc["cmdId"] = cmdId;
    doc["deviceId"] = DEVICE_ID;
    doc["ts"] = nowMs();
    doc["nonce"] = nonce;
    doc["status"] = status;
    if (reason) doc["reason"] = reason;
    JsonObject st = doc["state"].to<JsonObject>();
    if (HAS_PUMP) {
        st["pump"]["on"] = pumpOn;
        st["pump"]["duty"] = pumpDuty;
    }
    st["intervalMs"] = intervalMs;
    size_t n = serializeJson(doc, buf, sizeof(buf));
    publishSigned(T_ACK, buf, n, false, 1);
}

static bool validCmdId(const char* s) {
    if (!s) return false;
    size_t n = strlen(s);
    if (n < 8 || n > 64) return false;
    for (size_t i = 0; i < n; i++) if (!isalnum((unsigned char)s[i]) && s[i] != '-') return false;
    return true;
}
static bool validNonce(const char* s) {
    if (!s || strlen(s) != 16) return false;
    for (int i = 0; i < 16; i++) if (!isxdigit((unsigned char)s[i]) || isupper((unsigned char)s[i])) return false;
    return true;
}

static void handleCommand(const char* raw, int len) {
    JsonDocument doc;
    if (deserializeJson(doc, raw, len)) {
        Serial.println("command dropped: invalid JSON");
        return;
    }
    const char* cmdId = doc["cmdId"];
    const char* deviceId = doc["deviceId"];
    const char* nonce = doc["nonce"];
    const char* type = doc["type"];
    uint64_t ts = doc["ts"] | 0ULL;
    // 1. schema
    if (!validCmdId(cmdId)) return;  // cannot even acknowledge
    if ((doc["v"] | 0) != 1 || !deviceId || !validNonce(nonce) || !type || ts == 0 || !doc["params"].is<JsonObject>() ||
        !doc["issuedBy"].is<const char*>()) {
        return sendAck(cmdId, "rejected", "invalid_params");
    }
    // 2. addressed to me?
    if (strcmp(deviceId, DEVICE_ID) != 0) return sendAck(cmdId, "rejected", "wrong_device");
    // 3. signature (over the exact received bytes)
    twin::VerifyResult v = twin::verifyMessage(raw, len, deviceKey);
    if (v == twin::VerifyResult::MissingSignature) return sendAck(cmdId, "rejected", "missing_signature");
    if (v == twin::VerifyResult::BadSignature) return sendAck(cmdId, "rejected", "bad_signature");
    // 4. freshness (needs a synchronised clock)
    if (!ntpSynced || !twin::isFresh(nowMs(), ts, CMD_MAX_SKEW_MS)) return sendAck(cmdId, "rejected", "stale_timestamp");
    // 5. replay
    if (!nonces.checkAndRemember(nonce, nowMs(), NONCE_TTL_MS)) return sendAck(cmdId, "rejected", "replayed_nonce");

    // 6. execute
    JsonObject params = doc["params"];
    if (strcmp(type, "pump.set") == 0) {
        if (!HAS_PUMP) return sendAck(cmdId, "rejected", "not_supported");
        if (!params["on"].is<bool>()) return sendAck(cmdId, "rejected", "invalid_params");
        if (!params["duty"].isNull()) {
            int duty = params["duty"] | -1;
            if (duty < 0 || duty > 100) return sendAck(cmdId, "rejected", "invalid_params");
            pumpDuty = (uint8_t)duty;
        }
        pumpOn = params["on"].as<bool>();
        applyPump();
    } else if (strcmp(type, "telemetry.set_interval") == 0) {
        int ms = params["intervalMs"] | -1;
        if (ms < MIN_INTERVAL_MS || ms > MAX_INTERVAL_MS) return sendAck(cmdId, "rejected", "invalid_params");
        intervalMs = (uint32_t)ms;
    } else if (strcmp(type, "ping") != 0) {
        return sendAck(cmdId, "rejected", "unknown_command");
    }
    Serial.printf("executed %s from %s\n", type, (const char*)doc["issuedBy"]);
    sendAck(cmdId, "executed", nullptr);
}

// ----------------------------------------------------------------- serial console
static void handleSerial() {
    static String line;
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\r') continue;
        if (c != '\n') {
            if (line.length() < 120) line += c;
            continue;
        }
        if (calib.handleLine(line, Serial)) {
            // handled
        } else if (line == "status") {
            Serial.printf("%s fw %s boot %s | wifi %s rssi %d | mqtt %s | ntp %s | ads %s | pump %s %u%% | interval %u ms | pulses %u\n",
                          DEVICE_ID, FW_VERSION, bootId, WiFi.isConnected() ? "up" : "down", WiFi.RSSI(),
                          mqtt.connected() ? "up" : "down", ntpSynced ? "synced" : "NOT synced", adsOk ? "ok" : "FAULT",
                          pumpOn ? "on" : "off", pumpDuty, intervalMs, (unsigned)pulseTotal);
        } else if (line.length()) {
            Serial.println("commands: status | cal show | cal set <name> <value> | cal save | cal reset | raw on|off");
        }
        line = "";
    }
}

// ----------------------------------------------------------------- setup / loop
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.printf("\n=== %s firmware %s ===\n", DEVICE_ID, FW_VERSION);
    twin::randomHex(bootId, 4, rand32);

    if (!twin::hexToKey(DEVICE_KEY_HEX, deviceKey)) {
        Serial.println("FATAL: DEVICE_KEY_HEX invalid - regenerate secrets");
        while (true) delay(1000);
    }
    calib.begin(P_NAMES, N_P, F_NAME);

    // sensors
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    adsOk = ads.begin(ADS1115_ADDR, &Wire);
    if (adsOk) {
        ads.setGain(GAIN_ONE);                    // +/-4.096 V full scale
        ads.setDataRate(RATE_ADS1115_860SPS);     // ~1.2 ms per conversion
    }
    Serial.printf("ADS1115: %s\n", adsOk ? "ok" : "NOT FOUND (pressures reported as fault)");
    pinMode(PIN_FLOW, INPUT);  // the YF-S201 has its own pull-up (to 5 V, through our divider)
    attachInterrupt(digitalPinToInterrupt(PIN_FLOW), onPulse, FALLING);

    // pump: OFF at boot (safe state); started by the platform/operator
    if (HAS_PUMP) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
        ledcAttach(PIN_PUMP_PWM, PUMP_PWM_FREQ_HZ, PUMP_PWM_BITS);
#else
        ledcSetup(0, PUMP_PWM_FREQ_HZ, PUMP_PWM_BITS);
        ledcAttachPin(PIN_PUMP_PWM, 0);
#endif
        applyPump();
    }

    // network
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.printf("WiFi: connecting to %s", WIFI_SSID);
    for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
        delay(250);
        Serial.print('.');
    }
    Serial.printf(" %s\n", WiFi.isConnected() ? WiFi.localIP().toString().c_str() : "not yet (keeps trying)");

    configTime(0, 0, NTP_SERVER_1, NTP_SERVER_2);  // UTC; device timestamps are epoch ms

    net.setCACert(CA_CERT_PEM);  // trust ONLY the project CA (anti-MITM); hostname is verified too
    mqtt.begin(MQTT_HOST, MQTT_PORT, net);
    mqtt.setKeepAlive(MQTT_KEEPALIVE_S);
    mqtt.setCleanSession(true);
    mqtt.setWill(T_STATUS, "{\"v\":1,\"deviceId\":\"" DEVICE_ID "\",\"online\":false,\"reason\":\"lwt\"}", true, 1);
    mqtt.onMessageAdvanced(onMqttMessage);

    // watchdog: reboot if the main loop hangs for 30 s
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    esp_task_wdt_config_t wdt = {.timeout_ms = 30000, .idle_core_mask = 0, .trigger_panic = true};
    esp_task_wdt_reconfigure(&wdt);
#else
    esp_task_wdt_init(30, true);
#endif
    esp_task_wdt_add(nullptr);
    lastPublishMs = lastSampleMs = lastMqttOkMs = millis();
}

void loop() {
    esp_task_wdt_reset();
    uint32_t now = millis();

    if (!ntpSynced && time(nullptr) > 1600000000) {
        ntpSynced = true;
        Serial.println("NTP: clock synchronised");
    }

    mqtt.loop();
    ensureConnected();

    while (cmdTail != cmdHead) {
        handleCommand(cmdQueue[cmdTail].data, cmdQueue[cmdTail].len);
        cmdTail = (cmdTail + 1) % 4;
    }

    if (now - lastSampleMs >= SAMPLE_PERIOD_MS) {
        lastSampleMs = now;
        sampleAdc();
    }
    if (now - lastPublishMs >= intervalMs) publishTelemetry();

    // Fail-safe: platform unreachable for too long -> stop the pump.
    if (HAS_PUMP && LINK_LOSS_PUMP_STOP_S > 0 && pumpOn && now - lastMqttOkMs > LINK_LOSS_PUMP_STOP_S * 1000UL) {
        pumpOn = false;
        applyPump();
        Serial.println("FAIL-SAFE: platform unreachable, pump stopped");
    }

    handleSerial();
}

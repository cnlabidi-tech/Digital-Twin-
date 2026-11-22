// Simulated hardware for the host conformance run of src/main.cpp.
// Published MQTT messages are printed on stdout as:  PUB <topic> <payload>
// Firmware logs go to stderr.
#include <stdlib.h>
#include <sys/time.h>
#include "Arduino.h"
#include "WiFi.h"
#include "MQTT.h"
#include "Adafruit_ADS1X15.h"
#include "Preferences.h"
#include "esp_random.h"
#include "esp_task_wdt.h"

SerialStub Serial;
EspStub ESP;
WiFiStub WiFi;
TwoWire Wire;

uint32_t g_ms = 0;            // simulated millis()
uint64_t g_us = 0;            // simulated micros()
void (*g_isr)() = nullptr;    // flow-meter interrupt handler registered by the firmware
MQTTClientCallbackAdvanced g_onMessage = nullptr;
MQTTClient* g_client = nullptr;
bool g_connected = false;      // becomes true when the firmware calls connect()

uint32_t millis() { return g_ms; }
uint32_t micros() { return (uint32_t)g_us; }
void delay(uint32_t ms) { g_ms += ms; g_us += ms * 1000ULL; }
void pinMode(int, int) {}
int digitalPinToInterrupt(int p) { return p; }
void attachInterrupt(int, void (*f)(), int) { g_isr = f; }
void ledcSetup(int, int, int) {}
void ledcAttachPin(int, int) {}
void ledcWrite(int, uint32_t v) { fprintf(stderr, "[sim] pump PWM = %u\n", v); }
void configTime(long, int, const char*, const char*, const char*) {}
uint32_t EspStub::getFreeHeap() { return 200000; }
uint32_t esp_random() { return (uint32_t)rand() * 2654435761u; }
int esp_task_wdt_init(uint32_t, bool) { return 0; }
int esp_task_wdt_add(void*) { return 0; }
int esp_task_wdt_reset() { return 0; }

void WiFiStub::mode(int) {}
void WiFiStub::setAutoReconnect(bool) {}
void WiFiStub::begin(const char*, const char*) {}
int WiFiStub::status() { return WL_CONNECTED; }
bool WiFiStub::isConnected() { return true; }
int WiFiStub::RSSI() { return -55; }
IPAddress WiFiStub::localIP() { return IPAddress(); }
void WiFiClientSecure::setCACert(const char*) {}
bool TwoWire::begin(int, int) { return true; }

// ADS1115: 4.10 bar on channel 0, 3.60 bar on channel 1, with +/-3 counts of noise
bool Adafruit_ADS1115::begin(uint8_t, TwoWire*) { return true; }
void Adafruit_ADS1115::setGain(adsGain_t) {}
void Adafruit_ADS1115::setDataRate(uint16_t) {}
int16_t Adafruit_ADS1115::readADC_SingleEnded(uint8_t ch) { return (ch == 0 ? 14071 : 13034) + (rand() % 7) - 3; }

bool Preferences::begin(const char*, bool) { return true; }
void Preferences::end() {}
float Preferences::getFloat(const char*, float d) { return d; }
size_t Preferences::putFloat(const char*, float) { return 4; }

MQTTClient::MQTTClient(int) { g_client = this; }
void MQTTClient::begin(const char*, int, WiFiClientSecure&) {}
void MQTTClient::setKeepAlive(int) {}
void MQTTClient::setCleanSession(bool) {}
void MQTTClient::setWill(const char t[], const char p[], bool, int) { printf("WILL %s %s\n", t, p); }
void MQTTClient::onMessageAdvanced(MQTTClientCallbackAdvanced cb) { g_onMessage = cb; }
bool MQTTClient::connect(const char*, const char*, const char*, bool) { return g_connected = true; }
bool MQTTClient::publish(const char t[], const char p[], int len, bool, int) { printf("PUB %s %.*s\n", t, len, p); fflush(stdout); return true; }
bool MQTTClient::subscribe(const char*, int) { return true; }
bool MQTTClient::loop() { return true; }
bool MQTTClient::connected() { return g_connected; }
int MQTTClient::lastError() { return 0; }
int MQTTClient::returnCode() { return 0; }

// =============================================================================
// Node configuration (pins, timings). Per-device secrets are in secrets_*.h,
// calibration constants in NVS (serial command "cal", see twin_calib.h).
// The node role is chosen at build time: -DNODE_INLET or -DNODE_DOWNSTREAM.
// =============================================================================
#pragma once

#if defined(NODE_INLET)
#define DEVICE_ID "node-inlet"
#elif defined(NODE_DOWNSTREAM)
#define DEVICE_ID "node-downstream"
#else
#error "Build with -DNODE_INLET or -DNODE_DOWNSTREAM (see platformio.ini)"
#endif

#define FW_VERSION "1.0.0"

// ------------------------------------------------------------------ pins
// ESP32-S3-DevKitC-1. Avoid strapping pins (0, 3, 45, 46) and USB (19, 20).
#define PIN_I2C_SDA 8        // ADS1115 SDA
#define PIN_I2C_SCL 9        // ADS1115 SCL
#define ADS1115_ADDR 0x48    // ADDR pin to GND
#define PIN_FLOW 4           // YF-S201 signal (through the 5 V -> 3.3 V divider)
#define PIN_PUMP_PWM 6       // D4184 MOSFET module input (inlet node only)
#define PIN_STATUS_LED 48    // on-board RGB/LED (optional)

// ADS1115 channels
#if defined(NODE_INLET)
#define CH_P1 0
#else
#define CH_P2 0
#define CH_P3 1
#endif

// ------------------------------------------------------------------ timing
#define SAMPLE_PERIOD_MS 20            // ADC oversampling: 50 Hz per channel
#define DEFAULT_INTERVAL_MS 500        // telemetry period (changeable by command)
#define MIN_INTERVAL_MS 200
#define MAX_INTERVAL_MS 10000
#define MQTT_KEEPALIVE_S 10            // broker publishes our last will ~15 s after loss
#define CMD_MAX_SKEW_MS 30000ULL       // command freshness window
#define NONCE_TTL_MS (2 * CMD_MAX_SKEW_MS)
#define FLOW_DEBOUNCE_US 1000          // ignore glitches shorter than 1 ms (max ~ 500 Hz)

// Fail-safe: stop the pump if the platform has been unreachable this long
// (the twin cannot watch the pipe). 0 disables.
#define LINK_LOSS_PUMP_STOP_S 120

// ------------------------------------------------------------------ pump PWM
#define PUMP_PWM_FREQ_HZ 1000
#define PUMP_PWM_BITS 10

// ------------------------------------------------------------------ buffers
#define MQTT_BUFFER_SIZE 1536
#define JSON_BUFFER_SIZE 1024

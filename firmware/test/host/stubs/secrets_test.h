// Fixed TEST secrets for the host conformance run (not used on any device).
#pragma once
#define WIFI_SSID "test"
#define WIFI_PASS "test"
#define MQTT_HOST "localhost"
#define MQTT_PORT 8883
#define MQTT_USER DEVICE_ID
#define MQTT_PASS "test"
#define DEVICE_KEY_HEX "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"
#define NTP_SERVER_1 "pool.ntp.org"
#define NTP_SERVER_2 MQTT_HOST
static const char CA_CERT_PEM[] = "test";

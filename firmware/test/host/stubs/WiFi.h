#pragma once
#include "Arduino.h"
#define WL_CONNECTED 3
#define WIFI_STA 1
struct IPAddress { String toString() const { return String("0.0.0.0"); } };
struct WiFiStub { void mode(int); void setAutoReconnect(bool); void begin(const char*, const char*); int status(); bool isConnected(); int RSSI(); IPAddress localIP(); };
extern WiFiStub WiFi;

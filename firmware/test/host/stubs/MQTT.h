#pragma once
#include "WiFiClientSecure.h"
class MQTTClient;
typedef void (*MQTTClientCallbackAdvanced)(MQTTClient* client, char topic[], char bytes[], int length);
class MQTTClient {
 public:
  explicit MQTTClient(int bufSize = 128);
  void begin(const char host[], int port, WiFiClientSecure& c);
  void setKeepAlive(int);
  void setCleanSession(bool);
  void setWill(const char topic[], const char payload[], bool retained, int qos);
  void onMessageAdvanced(MQTTClientCallbackAdvanced cb);
  bool connect(const char clientId[], const char username[], const char password[], bool skip = false);
  bool publish(const char topic[], const char payload[], int length, bool retained, int qos);
  bool subscribe(const char topic[], int qos);
  bool loop();
  bool connected();
  int lastError(); int returnCode();
};

// Runs the real firmware loop for a few simulated seconds.
//   ./node [<command json> ...]   commands are delivered after 2 s, one per second
#include <stdlib.h>
#include <string.h>
#include "Arduino.h"
#include "MQTT.h"
#include "config.h"
void setup();
void loop();
extern uint32_t g_ms;
extern uint64_t g_us;
extern void (*g_isr)();
extern MQTTClientCallbackAdvanced g_onMessage;
extern MQTTClient* g_client;

int main(int argc, char** argv) {
    srand(42);
    setup();
    const uint32_t endMs = 3000 + (uint32_t)(argc - 1) * 1000;
    double nextPulseUs = 0;
    int nextCmd = 1;
    while (g_ms < endMs) {
        g_ms += 1;
        g_us += 1000;
        while (g_us >= nextPulseUs) {  // 26 Hz pulse train = 3.47 L/min at K = 7.5
            if (g_isr) g_isr();
            nextPulseUs += 1e6 / 26.0;
        }
        if (nextCmd < argc && g_ms >= 2000u + (uint32_t)(nextCmd - 1) * 1000u) {
            char topic[64] = "pipeline/v1/" DEVICE_ID "/cmd";
            g_onMessage(g_client, topic, argv[nextCmd], (int)strlen(argv[nextCmd]));
            nextCmd++;
        }
        loop();
    }
    return 0;
}

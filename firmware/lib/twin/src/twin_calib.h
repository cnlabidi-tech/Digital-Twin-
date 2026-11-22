// Calibration constants, stored in NVS (flash) so they survive reboots and
// firmware updates. Changed ONLY through the USB serial console (physical
// access), never over the network: a remote "calibration" command would be a
// perfect false-data-injection channel.
//
// Serial commands (115200 baud):
//   cal show                     print all constants
//   cal set <name> <value>       e.g. cal set P1.offset 0.021   cal set F1.k 7.62   cal set divider 0.6652
//   cal save                     write to NVS
//   cal reset                    factory values
//   raw on|off                   stream raw ADC counts and pulse totals (for the calibration tool)
#pragma once
#include <Arduino.h>

#include "twin_sensors.h"

namespace twin {

struct Calibration {
    PressureElec elec;          // shared electrical chain (divider ratio)
    PressureCal pressure[2];    // index 0/1 = first/second pressure channel of this node
    float flowK = 7.5f;         // pulses/s per L/min of this node's flow meter
};

class CalibrationStore {
   public:
    void begin(const char* const* pressureNames, int nPressure, const char* flowName);
    Calibration& get() { return cal_; }
    // Handle one serial line; returns true if it was a calibration command.
    bool handleLine(const String& line, Print& out);
    bool rawStreaming() const { return raw_; }

   private:
    void load();
    void save();
    void show(Print& out);
    Calibration cal_;
    const char* const* pNames_ = nullptr;
    int nP_ = 0;
    const char* fName_ = "F";
    bool raw_ = false;
};

}  // namespace twin

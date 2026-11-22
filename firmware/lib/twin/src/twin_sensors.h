// Sensor conversions (portable). Identical to tools/emulator/src/firmware-logic.ts.
//
// Pressure chain:  0-10 bar -> transducer 1-5 V -> divider (x 2/3) -> ADS1115 (PGA +/-4.096 V, 16 bit)
// Flow:            YF-S201 hall sensor, f[Hz] = K x Q[L/min], K ~ 7.5 (calibrated per sensor)
#pragma once
#include <stdint.h>

namespace twin {

enum class Quality { Ok, OutOfRange, Fault };
const char* qualityName(Quality q);

struct PressureCal {
    float offsetBar = 0.0f;  // added after conversion (zero adjustment)
    float gain = 1.0f;       // multiplied (span adjustment)
};

struct PressureElec {
    float vMin = 1.0f;          // transducer output at 0 bar
    float vMax = 5.0f;          // transducer output at full scale
    float rangeBar = 10.0f;     // full scale
    float divider = 2.0f / 3.0f;  // resistor divider ratio (measured in Phase 8)
    float adcFullScaleV = 4.096f;
    float adcCounts = 32768.0f;
};

struct PressureReading {
    float bar;  // NAN if quality != Ok
    int32_t raw;
    Quality q;
};

// avgCounts: mean of the ADS1115 samples taken during the window.
PressureReading countsToPressure(float avgCounts, const PressureCal& cal, const PressureElec& e = PressureElec());

// Inverse (used by tests and the calibration tool).
int32_t pressureToCounts(float bar, const PressureElec& e = PressureElec());

struct FlowReading {
    float lpm;
    uint32_t rawTotal;  // cumulative pulse count since boot
    Quality q;
};

// totalNow / totalPrev: cumulative pulse counters; windowS: elapsed time; k: pulses/s per L/min.
FlowReading pulsesToFlow(uint32_t totalNow, uint32_t totalPrev, float windowS, float k);

// Round to 3 decimals (what is sent on the wire).
float round3(float x);

}  // namespace twin

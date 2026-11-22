#include "twin_sensors.h"

#include <math.h>

namespace twin {

const char* qualityName(Quality q) {
    switch (q) {
        case Quality::Ok: return "ok";
        case Quality::OutOfRange: return "out_of_range";
        default: return "fault";
    }
}

float round3(float x) { return roundf(x * 1000.0f) / 1000.0f; }

PressureReading countsToPressure(float avgCounts, const PressureCal& cal, const PressureElec& e) {
    PressureReading r;
    r.raw = (int32_t)lroundf(avgCounts);
    float vAdc = avgCounts * e.adcFullScaleV / e.adcCounts;
    float vSensor = vAdc / e.divider;
    // Live zero: a 1-5 V transducer never outputs < 1 V when powered and wired.
    if (vSensor < e.vMin - 0.1f || vSensor > e.vMax + 0.1f) {
        r.bar = NAN;
        r.q = Quality::OutOfRange;
        return r;
    }
    float bar = (vSensor - e.vMin) / (e.vMax - e.vMin) * e.rangeBar;
    r.bar = round3(bar * cal.gain + cal.offsetBar);
    r.q = Quality::Ok;
    return r;
}

int32_t pressureToCounts(float bar, const PressureElec& e) {
    float v = e.vMin + bar / e.rangeBar * (e.vMax - e.vMin);
    float counts = v * e.divider / e.adcFullScaleV * e.adcCounts;
    if (counts > 32767.0f) counts = 32767.0f;
    if (counts < -32768.0f) counts = -32768.0f;
    return (int32_t)lroundf(counts);
}

FlowReading pulsesToFlow(uint32_t totalNow, uint32_t totalPrev, float windowS, float k) {
    FlowReading r;
    r.rawTotal = totalNow;
    uint32_t delta = totalNow - totalPrev;  // unsigned arithmetic also handles counter wrap-around
    float lpm = (windowS > 0.0f && k > 0.0f) ? (float)delta / windowS / k : 0.0f;
    r.lpm = round3(lpm < 0 ? 0 : lpm);
    r.q = Quality::Ok;
    return r;
}

}  // namespace twin

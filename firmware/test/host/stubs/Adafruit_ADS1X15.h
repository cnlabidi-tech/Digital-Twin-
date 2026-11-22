#pragma once
#include <stdint.h>
#include "Wire.h"
enum adsGain_t { GAIN_ONE };
#define RATE_ADS1115_860SPS 0x00E0
class Adafruit_ADS1115 { public: bool begin(uint8_t addr, TwoWire* w); void setGain(adsGain_t); void setDataRate(uint16_t); int16_t readADC_SingleEnded(uint8_t ch); };

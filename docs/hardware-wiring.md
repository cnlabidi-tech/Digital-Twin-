# Hardware wiring (Phase 7)

## ESP32 #1 - inlet node

| From | To | Notes |
|------|----|-------|
| 12 V PSU + | pump + (through D4184 OUT+), transducer P1 supply | PSU >= 5 A |
| 12 V PSU - | D4184 OUT-/GND, transducer GND, **ESP32 GND** | common ground |
| Pump | D4184 OUT+ / OUT- | add flyback diode (SS34 / 1N5822) across the pump, cathode to + |
| ESP32 GPIO 6 | D4184 PWM/IN | 1 kHz PWM, 3.3 V logic |
| ESP32 3V3 / GND | ADS1115 VDD / GND | ADS1115 at 3.3 V (its I2C is then safe for the ESP32) |
| ESP32 GPIO 8 / 9 | ADS1115 SDA / SCL | ADDR to GND (0x48) |
| P1 signal (1-5 V) | divider 10 kOhm (top) / 20 kOhm (bottom) -> ADS1115 A0 | 1-5 V -> 0.67-3.33 V |
| YF-S201 red / black | 5 V / GND | |
| YF-S201 yellow | divider 10 kOhm / 20 kOhm -> GPIO 4 | 5 V pulses -> 3.3 V |

## ESP32 #2 - downstream node

| From | To | Notes |
|------|----|-------|
| 12 V PSU (shared or own) | P2, P3 transducer supply | common ground with ESP32 #2 |
| ESP32 3V3 / GND / GPIO 8 / GPIO 9 | ADS1115 VDD / GND / SDA / SCL | |
| P2 signal | divider -> ADS1115 A0 | mid-line |
| P3 signal | divider -> ADS1115 A1 | outlet |
| YF-S201 F2 | 5 V / GND, signal via divider -> GPIO 4 | outlet, after P3 |

## Divider

```
sensor out ---[ 10 kOhm ]---+---[ 20 kOhm ]--- GND
                            |
                       ADS1115 Ax  (or GPIO 4 for the flow meter)
```
Ratio 20/(10+20) = 0.667. Measure the real ratio with a multimeter (or with the
calibration tool, Phase 8) and store it: `cal set divider 0.6652`, `cal save`.

## Checklist before power-on

- [ ] No signal above 3.3 V reaches the ESP32 or the ADS1115 (measure each divider output at 5 V input).
- [ ] Common ground between 12 V supply, sensors, ADS1115, ESP32s.
- [ ] Flyback diode on the pump.
- [ ] Pump wired through the MOSFET module, never directly to a GPIO.
- [ ] Flow meters mounted in the arrow direction, straight pipe before them.

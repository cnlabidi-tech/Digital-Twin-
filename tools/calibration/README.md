# tools/calibration

Hardware bring-up and calibration. Works with the real boards and with the
emulator (same MQTT traffic). Full procedure: [docs/integration-guide.md](../../docs/integration-guide.md).

```bash
npm run check -w @twin/calibration -- --seconds 20 --commands      # bring-up + commissioning report
npm run cal -w @twin/calibration -- divider --vin 4.998 --vout 3.326
npm run cal -w @twin/calibration -- zero --device node-inlet
npm run cal -w @twin/calibration -- span --sensor P1 --reference 3.5 --offset 0.012
npm run cal -w @twin/calibration -- flow --device node-inlet --volume 2.0
npm run cal -w @twin/calibration -- emulator-params
```

Measurements are read-only (monitor account). Results are printed as serial
console lines (`cal set ...`, `cal save`): calibration is never sent over the network.

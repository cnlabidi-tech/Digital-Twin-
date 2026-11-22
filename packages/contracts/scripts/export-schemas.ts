/** Writes the JSON Schemas to docs/contracts/ so non-TS readers (firmware, thesis) can use them. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AckSchema, CommandSchema, StatusSchema, TelemetrySchema } from '../src/schemas';

const out = resolve(import.meta.dirname, '../../../docs/contracts');
mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries({ telemetry: TelemetrySchema, status: StatusSchema, command: CommandSchema, ack: AckSchema })) {
  writeFileSync(resolve(out, `${name}.schema.json`), JSON.stringify(schema, null, 2) + '\n');
  console.log(`wrote docs/contracts/${name}.schema.json`);
}

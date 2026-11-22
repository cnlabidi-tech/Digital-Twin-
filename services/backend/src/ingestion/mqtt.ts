/** The backend's MQTT connection (shared by ingestion and, later, control). */
import { readFileSync } from 'node:fs';
import mqtt, { type MqttClient } from 'mqtt';
import { config } from '../config';

export function connectMqtt(log: { info: (m: string) => void; warn: (m: string) => void }): MqttClient {
  const c = config.mqtt;
  const client = mqtt.connect(c.url, {
    clientId: c.clientId,
    username: c.username,
    password: c.password,
    ca: c.caFile ? readFileSync(c.caFile) : undefined,
    clean: true,
    reconnectPeriod: 2000,
  });
  client.on('connect', () => log.info(`MQTT connected to ${c.url}`));
  client.on('reconnect', () => log.warn('MQTT reconnecting'));
  client.on('error', (e) => log.warn(`MQTT error: ${e.message}`));
  return client;
}

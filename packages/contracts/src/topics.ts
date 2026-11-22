/**
 * MQTT topic tree.
 *
 *   pipeline/v1/<deviceId>/telemetry   device -> platform   QoS 0
 *   pipeline/v1/<deviceId>/status      device -> platform   QoS 1, retained (+ last will)
 *   pipeline/v1/<deviceId>/cmd         platform -> device   QoS 1
 *   pipeline/v1/<deviceId>/ack         device -> platform   QoS 1
 *
 * The device id is the 3rd level so that broker ACLs (Phase 6) can use the
 * pattern  pipeline/v1/%u/#  : a device can only touch its own sub-tree.
 */
import { DEVICE_IDS, type DeviceId } from './devices';

export const TOPIC_ROOT = 'pipeline/v1';

export const CHANNELS = ['telemetry', 'status', 'cmd', 'ack'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Recommended QoS / retain per channel. */
export const CHANNEL_QOS: Record<Channel, { qos: 0 | 1; retain: boolean }> = {
  telemetry: { qos: 0, retain: false }, // high rate, a lost sample is acceptable
  status: { qos: 1, retain: true }, // last known online/offline state
  cmd: { qos: 1, retain: false }, // must arrive; never retained (would replay on reconnect)
  ack: { qos: 1, retain: false },
};

export const topicFor = (deviceId: DeviceId, channel: Channel): string =>
  `${TOPIC_ROOT}/${deviceId}/${channel}`;

/** Wildcard subscription for one channel on all devices, e.g. pipeline/v1/+/telemetry */
export const topicAll = (channel: Channel): string => `${TOPIC_ROOT}/+/${channel}`;

/** Parse a topic; returns null if it is not part of our contract. */
export function parseTopic(topic: string): { deviceId: DeviceId; channel: Channel } | null {
  const parts = topic.split('/');
  if (parts.length !== 4 || `${parts[0]}/${parts[1]}` !== TOPIC_ROOT) return null;
  const deviceId = parts[2] as DeviceId;
  const channel = parts[3] as Channel;
  if (!DEVICE_IDS.includes(deviceId) || !CHANNELS.includes(channel)) return null;
  return { deviceId, channel };
}

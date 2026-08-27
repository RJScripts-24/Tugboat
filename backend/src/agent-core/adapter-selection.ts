import type { ChannelAdapter } from "../channels/channel-adapter.interface";

export type AdapterMaps = {
  /** The lanes as configured — real where a key and `CHANNEL_MODE_*=real` say so. */
  configured: Map<string, ChannelAdapter>;
  /** The four simulated adapters, or null where a test wired only one map. */
  simulated: Map<string, ChannelAdapter> | null;
};

/**
 * A batch case is worked by the simulated adapters whatever the lanes say; a
 * live case by the configured ones. The timeline's label is read off the
 * adapter that answered, so a batch never claims a real message (D-140).
 */
export function adapterFor(
  maps: AdapterMaps,
  simRunId: string | null,
  channel: string,
): ChannelAdapter | undefined {
  const map = simRunId !== null && maps.simulated ? maps.simulated : maps.configured;
  return map.get(channel);
}

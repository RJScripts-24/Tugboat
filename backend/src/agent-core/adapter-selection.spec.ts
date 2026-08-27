import type { ChannelAdapter } from "../channels/channel-adapter.interface";
import { adapterFor } from "./adapter-selection";

function adapter(channel: string, mode: "real" | "simulated"): ChannelAdapter {
  return { channel, mode, send: async () => ({}) } as unknown as ChannelAdapter;
}

describe("adapterFor — a batch case never reaches a real lane (D-140)", () => {
  const configured = new Map([
    ["EMAIL", adapter("EMAIL", "real")],
    ["WHATSAPP", adapter("WHATSAPP", "real")],
  ]);
  const simulated = new Map([
    ["EMAIL", adapter("EMAIL", "simulated")],
    ["WHATSAPP", adapter("WHATSAPP", "simulated")],
  ]);

  it("works a live case through the configured lane", () => {
    expect(adapterFor({ configured, simulated }, null, "EMAIL")?.mode).toBe("real");
  });

  it("works a batch case through the simulated lane whatever the configuration says", () => {
    expect(adapterFor({ configured, simulated }, "run-42", "EMAIL")?.mode).toBe("simulated");
    expect(adapterFor({ configured, simulated }, "run-42", "WHATSAPP")?.mode).toBe("simulated");
  });

  it("falls back to the configured map where only one map was wired", () => {
    expect(adapterFor({ configured, simulated: null }, "run-42", "EMAIL")?.mode).toBe("real");
  });

  it("answers undefined for a channel neither map knows", () => {
    expect(adapterFor({ configured, simulated }, null, "PIGEON")).toBeUndefined();
  });
});

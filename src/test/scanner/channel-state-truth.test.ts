import { describe, it, expect } from "vitest";
import {
  promoteOnInbound,
  DOWN_FLIP_DELAY_MS,
  type PillState,
} from "@/services/scanner/channelStateTruth";

describe("channelStateTruth.promoteOnInbound", () => {
  it("upgrades reconnecting → connected on inbound traffic", () => {
    expect(promoteOnInbound("reconnecting")).toBe("connected");
  });

  it("upgrades connecting → connected on inbound traffic", () => {
    expect(promoteOnInbound("connecting")).toBe("connected");
  });

  it("keeps connected as connected", () => {
    expect(promoteOnInbound("connected")).toBe("connected");
  });

  it("never upgrades revoked (terminal state)", () => {
    expect(promoteOnInbound("revoked")).toBe("revoked");
  });

  it("upgrade is referentially safe across all known states", () => {
    const states: PillState[] = ["connecting", "connected", "reconnecting", "revoked"];
    for (const s of states) {
      const next = promoteOnInbound(s);
      expect(["connected", "revoked"]).toContain(next);
    }
  });

  it("DOWN_FLIP_DELAY_MS is in the user-imperceptible band (<2s)", () => {
    expect(DOWN_FLIP_DELAY_MS).toBeGreaterThan(500);
    expect(DOWN_FLIP_DELAY_MS).toBeLessThan(2000);
  });
});

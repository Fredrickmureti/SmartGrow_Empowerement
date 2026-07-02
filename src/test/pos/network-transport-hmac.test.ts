/**
 * ADR-0014 Track D3 — HMAC sign/verify symmetry for the agent-sidecar
 * channel. Pure JS, no Electron needed, runs in the renderer Vitest pool.
 */
import { describe, it, expect } from "vitest";
import { NetworkTransport } from "../../../electron/hardware/transports/NetworkTransport";

describe("NetworkTransport HMAC", () => {
  const secret = "test-secret-do-not-use-in-prod";
  const body = JSON.stringify({ saleId: "abc", lines: [{ qty: 1 }] });
  const ts = "1779138000";

  it("verifies a freshly signed request", () => {
    const sig = NetworkTransport.sign(secret, ts, body);
    const res = NetworkTransport.verify(secret, ts, body, sig, { now: () => Number(ts) });
    expect(res.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = NetworkTransport.sign(secret, ts, body);
    const res = NetworkTransport.verify(secret, ts, body + "X", sig, { now: () => Number(ts) });
    expect(res.ok).toBe(false);
  });

  it("rejects skew > 30s", () => {
    const sig = NetworkTransport.sign(secret, ts, body);
    const res = NetworkTransport.verify(secret, ts, body, sig, { now: () => Number(ts) + 60 });
    expect(res.ok).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = NetworkTransport.sign(secret, ts, body);
    const res = NetworkTransport.verify("other-secret", ts, body, sig, { now: () => Number(ts) });
    expect(res.ok).toBe(false);
  });
});
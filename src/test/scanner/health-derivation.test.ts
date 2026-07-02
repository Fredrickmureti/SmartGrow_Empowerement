/**
 * deriveScannerHealth — table-driven contract.
 *
 * Pins the 8 s silence-degradation threshold and the priority order
 * `revoked > down > degraded > ok` so phone + desk stay in lockstep.
 */

import { describe, it, expect } from "vitest";
import {
  deriveScannerHealth,
  type ScannerChannelState,
  type ScannerHealth,
} from "@/hooks/scanner/useScannerHealth";

type Row = {
  name: string;
  online: boolean;
  state: ScannerChannelState;
  lastContactAt: number | null;
  now: number;
  expected: ScannerHealth;
};

const T = 1_000_000_000_000;

const rows: Row[] = [
  { name: "revoked beats everything",
    online: true, state: "revoked", lastContactAt: T, now: T, expected: "revoked" },
  { name: "revoked while offline still revoked",
    online: false, state: "revoked", lastContactAt: null, now: T, expected: "revoked" },
  { name: "offline → down",
    online: false, state: "connected", lastContactAt: T, now: T, expected: "down" },
  { name: "connecting → degraded",
    online: true, state: "connecting", lastContactAt: null, now: T, expected: "degraded" },
  { name: "reconnecting → degraded",
    online: true, state: "reconnecting", lastContactAt: T, now: T, expected: "degraded" },
  { name: "connected + fresh contact → ok",
    online: true, state: "connected", lastContactAt: T - 1000, now: T, expected: "ok" },
  { name: "connected + null contact → ok",
    online: true, state: "connected", lastContactAt: null, now: T, expected: "ok" },
  { name: "connected + 7.9s silence → ok (just under threshold)",
    online: true, state: "connected", lastContactAt: T - 7_900, now: T, expected: "ok" },
  { name: "connected + 8.1s silence → degraded",
    online: true, state: "connected", lastContactAt: T - 8_100, now: T, expected: "degraded" },
  { name: "connected + 60s silence → degraded",
    online: true, state: "connected", lastContactAt: T - 60_000, now: T, expected: "degraded" },
];

describe("deriveScannerHealth", () => {
  it.each(rows)("$name", (r) => {
    const out = deriveScannerHealth({
      online: r.online,
      channelState: r.state,
      lastContactAt: r.lastContactAt,
      now: r.now,
    });
    expect(out).toBe(r.expected);
  });

  it("defaults online to true when omitted", () => {
    const out = deriveScannerHealth({
      channelState: "connected",
      lastContactAt: T - 1000,
      now: T,
    });
    expect(out).toBe("ok");
  });
});
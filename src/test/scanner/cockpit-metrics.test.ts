/**
 * cockpitMetrics — pure helper contract tests.
 */

import { describe, it, expect } from "vitest";
import {
  appendLatencySample,
  deriveCockpitMetrics,
  formatUptime,
  LATENCY_WINDOW,
  medianLatency,
  scansInLastMinute,
} from "@/services/scanner/cockpitMetrics";

describe("formatUptime", () => {
  it("formats seconds, minutes, and hours correctly", () => {
    expect(formatUptime(0)).toBe("0:00");
    expect(formatUptime(45_000)).toBe("0:45");
    expect(formatUptime(60_000)).toBe("1:00");
    expect(formatUptime(125_000)).toBe("2:05");
    expect(formatUptime(3_725_000)).toBe("1:02:05");
  });
  it("guards against bogus input", () => {
    expect(formatUptime(-1)).toBe("0:00");
    expect(formatUptime(Number.NaN)).toBe("0:00");
  });
});

describe("scansInLastMinute", () => {
  const now = 100_000;
  it("counts only timestamps within the 60 s window", () => {
    expect(scansInLastMinute([now - 59_999, now - 30_000, now - 1, now - 60_001], now)).toBe(3);
    expect(scansInLastMinute([], now)).toBe(0);
  });
});

describe("appendLatencySample + medianLatency", () => {
  it("caps the buffer at LATENCY_WINDOW (drop-oldest)", () => {
    let s: number[] = [];
    for (let i = 0; i < LATENCY_WINDOW + 5; i++) s = appendLatencySample(s, i);
    expect(s.length).toBe(LATENCY_WINDOW);
    expect(s[0]).toBe(5);
  });
  it("ignores non-finite or negative samples", () => {
    const s = appendLatencySample(appendLatencySample([], -1), Number.NaN);
    expect(s).toEqual([]);
  });
  it("computes median for odd and even lengths", () => {
    expect(medianLatency([])).toBe(null);
    expect(medianLatency([10])).toBe(10);
    expect(medianLatency([10, 30, 20])).toBe(20);
    expect(medianLatency([10, 20, 30, 40])).toBe(25);
  });
});

describe("deriveCockpitMetrics", () => {
  it("returns zeros when not yet subscribed", () => {
    const m = deriveCockpitMetrics({
      subscribedAt: null,
      scanTimestamps: [],
      latencySamples: [],
      now: 10_000,
    });
    expect(m.uptimeMs).toBe(0);
    expect(m.uptimeLabel).toBe("0:00");
    expect(m.scansLastMin).toBe(0);
    expect(m.medianLatencyMs).toBe(null);
  });
  it("combines uptime + rolling rate + median latency", () => {
    const now = 200_000;
    const m = deriveCockpitMetrics({
      subscribedAt: now - 125_000,
      scanTimestamps: [now - 90_000, now - 45_000, now - 10_000],
      latencySamples: [100, 200, 300],
      now,
    });
    expect(m.uptimeLabel).toBe("2:05");
    expect(m.scansLastMin).toBe(2);
    expect(m.medianLatencyMs).toBe(200);
  });
});
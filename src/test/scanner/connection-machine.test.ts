/**
 * Connection state machine — Plan P3.
 *
 * Table-driven derivation test. Every row pins one (input tuple → label)
 * mapping; together they cover all 7 output labels and the precedence
 * order (revoked → session_expired → offline_queueing → reconnecting →
 * sync_delayed → paired_idle → ok).
 *
 * If a future change re-collapses signals or flips precedence, exactly
 * the rows it broke will fail — there is no ambiguity about what semantic
 * was lost.
 */
import { describe, it, expect } from "vitest";
import {
  deriveScannerConnection,
  OK_FRESHNESS_MS,
  SYNC_DELAYED_MS,
  type ScannerConnectionInputs,
  type ScannerConnectionLabel,
} from "@/hooks/scanner/useScannerConnectionMachine";

const NOW = 1_700_000_000_000;

function inputs(overrides: Partial<ScannerConnectionInputs> = {}): ScannerConnectionInputs {
  return {
    online: true,
    channelTransport: "subscribed",
    lastBroadcastAt: NOW - 1_000,
    pairingRowExists: true,
    revokedAt: null,
    restReachable: true,
    phoneQueueDepth: 0,
    ...overrides,
  };
}

interface Row {
  name: string;
  input: Partial<ScannerConnectionInputs>;
  expect: ScannerConnectionLabel;
}

const ROWS: Row[] = [
  // ── Happy path ───────────────────────────────────────────────────────
  { name: "subscribed + fresh broadcast → ok", input: {}, expect: "ok" },
  {
    name: "subscribed + no broadcast ever → paired_idle (treated as silent)",
    input: { lastBroadcastAt: null },
    expect: "paired_idle",
  },
  {
    name: "subscribed + last broadcast just under freshness → ok",
    input: { lastBroadcastAt: NOW - (OK_FRESHNESS_MS - 1) },
    expect: "ok",
  },
  {
    name: "subscribed + last broadcast at freshness boundary → paired_idle",
    input: { lastBroadcastAt: NOW - OK_FRESHNESS_MS },
    expect: "paired_idle",
  },

  // ── sync_delayed only when queue has work ────────────────────────────
  {
    name: "subscribed + silent > 60s + queue=3 → sync_delayed",
    input: { lastBroadcastAt: NOW - SYNC_DELAYED_MS - 1_000, phoneQueueDepth: 3 },
    expect: "sync_delayed",
  },
  {
    name: "subscribed + silent > 60s + empty queue → paired_idle (no work lost)",
    input: { lastBroadcastAt: NOW - SYNC_DELAYED_MS - 1_000, phoneQueueDepth: 0 },
    expect: "paired_idle",
  },

  // ── reconnecting (transport not subscribed) ──────────────────────────
  { name: "channel connecting → reconnecting", input: { channelTransport: "connecting" }, expect: "reconnecting" },
  { name: "channel closed → reconnecting", input: { channelTransport: "closed" }, expect: "reconnecting" },
  { name: "channel error → reconnecting", input: { channelTransport: "channel_error" }, expect: "reconnecting" },
  { name: "channel timed_out → reconnecting", input: { channelTransport: "timed_out" }, expect: "reconnecting" },

  // ── offline_queueing ─────────────────────────────────────────────────
  { name: "navigator offline + subscribed → offline_queueing", input: { online: false }, expect: "offline_queueing" },
  {
    name: "online but REST unreachable → offline_queueing",
    input: { restReachable: false },
    expect: "offline_queueing",
  },
  { name: "REST unknown (null) does not flip → ok", input: { restReachable: null }, expect: "ok" },

  // ── Terminal & precedence ────────────────────────────────────────────
  { name: "pairing row gone → session_expired", input: { pairingRowExists: false }, expect: "session_expired" },
  {
    name: "revoked beats session_expired",
    input: { revokedAt: NOW - 100, pairingRowExists: false },
    expect: "revoked",
  },
  {
    name: "revoked beats offline",
    input: { revokedAt: NOW - 100, online: false },
    expect: "revoked",
  },
  {
    name: "session_expired beats offline",
    input: { pairingRowExists: false, online: false },
    expect: "session_expired",
  },
  {
    name: "offline beats reconnecting (queue locally, don't chase channel)",
    input: { online: false, channelTransport: "channel_error" },
    expect: "offline_queueing",
  },
  {
    name: "reconnecting beats sync_delayed (must restore transport first)",
    input: { channelTransport: "closed", lastBroadcastAt: NOW - SYNC_DELAYED_MS - 1_000, phoneQueueDepth: 3 },
    expect: "reconnecting",
  },
];

describe("deriveScannerConnection — table-driven", () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const out = deriveScannerConnection(inputs(row.input), NOW);
      expect(out.label).toBe(row.expect);
    });
  }

  it("every output label is exercised by at least one row", () => {
    const seen = new Set(ROWS.map((r) => r.expect));
    const required: ScannerConnectionLabel[] = [
      "ok", "paired_idle", "reconnecting", "sync_delayed",
      "offline_queueing", "session_expired", "revoked",
    ];
    for (const label of required) {
      expect(seen, `missing coverage for ${label}`).toContain(label);
    }
  });

  it("subreason is non-empty for every label", () => {
    for (const row of ROWS) {
      const out = deriveScannerConnection(inputs(row.input), NOW);
      expect(out.subreason.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Replay policy — Plan P2.
 *
 * Locks the "stale doc_author scans NEVER auto-apply" invariant.
 * If this test fails, a regression has re-introduced the "rapid qty
 * increment during invoice draft after reconnect" bug.
 */
import { describe, it, expect } from "vitest";
import {
  decideReplayPolicy,
  LIVE_WINDOW_MS,
} from "@/services/scanner/replayPolicy";

const NOW = 1_700_000_000_000;

describe("decideReplayPolicy", () => {
  it("POS cart auto-applies regardless of age", () => {
    expect(
      decideReplayPolicy({ intent: "pos_sell", decodedAt: NOW - 60_000, receivedAt: NOW }),
    ).toBe("auto_apply");
    expect(
      decideReplayPolicy({ intent: "pos_sell", decodedAt: NOW, receivedAt: NOW }),
    ).toBe("auto_apply");
  });

  it("identity scans always auto-apply", () => {
    expect(
      decideReplayPolicy({ intent: "identity", decodedAt: NOW - 60_000, receivedAt: NOW }),
    ).toBe("auto_apply");
  });

  it("undefined intent falls back to auto_apply (no behavior change for legacy targets)", () => {
    expect(
      decideReplayPolicy({ intent: undefined, decodedAt: NOW - 60_000, receivedAt: NOW }),
    ).toBe("auto_apply");
  });

  it("doc_author auto-applies LIVE scans (within window)", () => {
    expect(
      decideReplayPolicy({
        intent: "doc_author",
        decodedAt: NOW - (LIVE_WINDOW_MS - 1),
        receivedAt: NOW,
      }),
    ).toBe("auto_apply");
  });

  it("doc_author routes STALE scans to review queue", () => {
    expect(
      decideReplayPolicy({
        intent: "doc_author",
        decodedAt: NOW - (LIVE_WINDOW_MS + 1),
        receivedAt: NOW,
      }),
    ).toBe("review_queue");
    expect(
      decideReplayPolicy({
        intent: "doc_author",
        decodedAt: NOW - 60_000,
        receivedAt: NOW,
      }),
    ).toBe("review_queue");
  });

  it("inventory_count and inventory_receive follow the same stale rule", () => {
    for (const intent of ["inventory_count", "inventory_receive"] as const) {
      expect(
        decideReplayPolicy({ intent, decodedAt: NOW - 60_000, receivedAt: NOW }),
      ).toBe("review_queue");
      expect(
        decideReplayPolicy({ intent, decodedAt: NOW - 100, receivedAt: NOW }),
      ).toBe("auto_apply");
    }
  });

  it("missing decodedAt is treated as live (no false stale)", () => {
    expect(
      decideReplayPolicy({ intent: "doc_author", decodedAt: undefined, receivedAt: NOW }),
    ).toBe("auto_apply");
  });

  it("negative age (clock skew) is clamped to live", () => {
    expect(
      decideReplayPolicy({
        intent: "doc_author",
        decodedAt: NOW + 5_000,
        receivedAt: NOW,
      }),
    ).toBe("auto_apply");
  });
});

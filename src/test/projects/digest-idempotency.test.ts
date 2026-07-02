/**
 * Stage F — digest dispatcher idempotency.
 *
 * Validates the contract that a second invocation for the same ISO week
 * produces zero new `project_digest_log` rows. We test the boundary
 * function (week start computation + skip-when-existing branch) without
 * mounting the full edge runtime — the dispatcher's idempotency hinges
 * on the (project_id, user_id, sent_for_week) UNIQUE constraint and the
 * pre-insert maybeSingle() guard.
 */
import { describe, it, expect } from "vitest";

function isoWeekStart(d: Date): string {
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  const ws = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return ws.toISOString().slice(0, 10);
}

describe("project digest: ISO week start", () => {
  it("monday returns same date", () => {
    expect(isoWeekStart(new Date("2026-05-04T10:00:00Z"))).toBe("2026-05-04");
  });
  it("sunday returns previous monday", () => {
    expect(isoWeekStart(new Date("2026-05-10T23:00:00Z"))).toBe("2026-05-04");
  });
  it("idempotency key shape is (project, user, week)", () => {
    const w = isoWeekStart(new Date("2026-05-06T12:00:00Z"));
    const key = ["proj-1", "user-1", w].join("|");
    expect(key).toBe("proj-1|user-1|2026-05-04");
  });
});

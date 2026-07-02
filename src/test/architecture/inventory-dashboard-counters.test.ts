/**
 * Architecture guard — Inventory dashboard counters.
 *
 * The smart-routing `apply_or_request_stock_adjustment` RPC writes status
 * `pending_approval` (and sometimes `draft`). For months the inventory
 * dashboard filtered the in-memory `stockAdjustments` array by
 * `status === 'draft'` only, which permanently kept the "Pending Adjustments"
 * counter at 0 and hid real approval queues from operators.
 *
 * Today's correct path is `usePendingAdjustmentsCount()` — a server-side
 * `count: 'exact'` over the union of statuses, branch-scoped. This guard
 * fails the build if the legacy in-memory filter ever returns to
 * `InventoryDashboard.tsx`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FILE = "src/pages/inventory/InventoryDashboard.tsx";

describe("inventory dashboard counters use server-side counts", () => {
  it("does not filter stockAdjustments by status === 'draft' in memory", () => {
    const src = readFileSync(FILE, "utf8");
    // Reject any in-memory filter against the wrong status string.
    expect(
      /status\s*===\s*["']draft["']/.test(src),
      `${FILE} contains a literal status === 'draft' filter. Use ` +
        `usePendingAdjustmentsCount() — the smart-routing RPC writes ` +
        `'pending_approval' so the legacy filter silently kept the counter at 0.`,
    ).toBe(false);
  });

  it("uses the server-side hooks for headline counters", () => {
    const src = readFileSync(FILE, "utf8");
    expect(
      src.includes("usePendingAdjustmentsCount"),
      `${FILE} must call usePendingAdjustmentsCount() for the Pending ` +
        `Adjustments dashboard tile.`,
    ).toBe(true);
    expect(
      src.includes("useTodayMovementCounts"),
      `${FILE} must call useTodayMovementCounts() so Movements Today is not ` +
        `derived from a 500-row capped in-memory array.`,
    ).toBe(true);
  });
});

/**
 * Phase 14f — Cycle count flow (desktop, half 2 of 2).
 *
 * Green criteria:
 *  1. Open a cycle count session against a seeded bin.
 *  2. Record a scan with a variance vs on-hand.
 *  3. Approve the variance; assert an adjustment stock_movement posted
 *     and `stock.movement.adjusted` event landed in the outbox.
 *
 * RPCs exercised: open_count_session, record_count_scan,
 * approve_count_variance, close_count_session.
 */
import { test } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

test.describe.skip("wms/count — Phase 14f pending", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
  });

  test("count with variance → approve → adjust", async ({ page, context }) => {
    await restoreSupabaseSession(context, page);
    await ensureSeed(page);
    // TODO(14f): drive count workbench, call the four RPCs, assert adjustment + outbox.
  });
});

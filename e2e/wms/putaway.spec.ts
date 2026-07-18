/**
 * Phase 14c — Putaway flow (desktop).
 *
 * Green criteria:
 *  1. Suggest a putaway task from a completed goods receipt.
 *  2. Assign it to an operator.
 *  3. Confirm the destination bin.
 *  4. Complete the task; assert quants moved from receiving to the bin.
 *
 * RPCs exercised: suggest_putaway_task, assign_wms_task,
 * complete_putaway_task.
 */
import { test } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

test.describe.skip("wms/putaway — Phase 14c pending", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
  });

  test("suggest → assign → complete", async ({ page, context }) => {
    await restoreSupabaseSession(context, page);
    await ensureSeed(page);
    // TODO(14c): drive putaway workbench, call the three RPCs, assert quants.
  });
});

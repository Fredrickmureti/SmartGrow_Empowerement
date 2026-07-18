/**
 * Phase 14b — Receive flow (desktop).
 *
 * Green criteria:
 *  1. Navigate to /warehouse-app/receiving.
 *  2. Create a blind goods receipt against seeded PO.
 *  3. Record one receipt line with lot + quantity.
 *  4. Complete the receipt.
 *  5. Assert a `stock.movement.received` event landed in the outbox.
 *
 * RPCs exercised: create_goods_receipt, record_goods_receipt_line,
 * complete_goods_receipt.
 */
import { test } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

test.describe.skip("wms/receive — Phase 14b pending", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
  });

  test("blind receipt → complete", async ({ page, context }) => {
    await restoreSupabaseSession(context, page);
    await ensureSeed(page);
    // TODO(14b): drive receiving page, call the three RPCs, assert outbox.
  });
});

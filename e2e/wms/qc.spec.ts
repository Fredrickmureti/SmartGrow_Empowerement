/**
 * Phase 14f — QC flow (desktop, half 1 of 2).
 *
 * Green criteria:
 *  1. Open a QC inspection against a received lot.
 *  2. Pass path: accept_qc_inspection releases the quant to available.
 *  3. Fail path: reject_qc_inspection moves it to a hold bin.
 *  4. Hold path: cancel_qc_inspection leaves quant on hold pending re-inspection.
 *
 * RPCs exercised: open_qc_inspection, accept_qc_inspection,
 * reject_qc_inspection, cancel_qc_inspection.
 */
import { test } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

test.describe.skip("wms/qc — Phase 14f pending", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
  });

  test("pass / fail / hold branches", async ({ page, context }) => {
    await restoreSupabaseSession(context, page);
    await ensureSeed(page);
    // TODO(14f): drive QC page, call the four RPCs, assert quant destinations.
  });
});

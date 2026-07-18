/**
 * Phase 14g — Mobile offline-queue drain (RF shell).
 *
 * Green criteria:
 *  1. Load /wm, restore Supabase session.
 *  2. Go offline (network route abort).
 *  3. Trigger an RPC via a mobile page (e.g. complete_pick_task in
 *     MobilePick). Assert it lands in IndexedDB (`wm-offline-queue`).
 *  4. Go online. Wait for the drain loop tick.
 *  5. Assert the queue is empty and the server-side row transitioned
 *     to the expected state (proves the RPC actually landed, not just
 *     that IndexedDB drained).
 *
 * Uses the /wm route tree; MobileWarehouseLayout must render the queue
 * indicator during the offline period.
 */
import { test } from "@playwright/test";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

test.describe.skip("wm/offline-drain — Phase 14g pending", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
  });

  test("enqueue offline → drain online → server state changed", async ({ page, context }) => {
    await restoreSupabaseSession(context, page);
    // TODO(14g): route.abort() all supabase calls, trigger enqueue(), toggle,
    // assert IndexedDB empty and server-side wms_tasks.state advanced.
  });
});

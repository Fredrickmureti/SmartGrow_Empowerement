/**
 * Phase 14e — Pick → Pack → Dispatch flow (desktop).
 *
 * Green criteria:
 *  1. Claim + complete a pick task from the released wave.
 *  2. Open a pack carton, assign it to the pack task, seal it.
 *  3. Open a loading manifest, load the sealed carton, close, dispatch.
 *  4. Assert `stock.movement.dispatched` event landed in the outbox.
 *
 * RPCs exercised: claim_pick_task, complete_pick_task, suggest_carton,
 * open_pack_carton, assign_carton_to_pack, seal_pack_carton,
 * complete_pack_task, open_loading_manifest, load_carton_onto_manifest,
 * close_loading_manifest, dispatch_loading_manifest.
 */
import { test } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

test.describe.skip("wms/pick-pack-dispatch — Phase 14e pending", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
  });

  test("pick → pack → seal → load → dispatch", async ({ page, context }) => {
    await restoreSupabaseSession(context, page);
    await ensureSeed(page);
    // TODO(14e): drive the four workstations, call the eleven RPCs, assert outbox.
  });
});

/**
 * Phase 14d — Wave flow (desktop).
 *
 * Green criteria:
 *  1. Build a wave from open sales orders in the seeded business.
 *  2. Release the wave; assert pick tasks generated with pick_sequence.
 *  3. Cancel-and-rebuild path is idempotent (no orphan tasks).
 *
 * RPCs exercised: build_pick_wave, release_pick_wave, cancel_pick_wave.
 */
import { test } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

test.describe.skip("wms/wave — Phase 14d pending", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
  });

  test("build → release → cancel-rebuild is idempotent", async ({ page, context }) => {
    await restoreSupabaseSession(context, page);
    await ensureSeed(page);
    // TODO(14d): drive wave planner, call the three RPCs, assert task graph.
  });
});

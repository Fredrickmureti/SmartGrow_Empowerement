/**
 * Deterministic E2E seed for WMS specs. Phase 14b.
 *
 * Delegates to the `wms_e2e_ensure_seed()` SQL function (see migration
 * 2026-07-18) so the fixture lives in one place and stays idempotent
 * across parallel workers. The function is scoped to the caller's
 * active business — restore the Supabase session first via
 * `restoreSupabaseSession` from `./auth`.
 *
 * Returns the resolved fixture IDs so specs can bind to the seeded
 * warehouse / locations / products / PO without a second round-trip.
 */
import type { Page } from "@playwright/test";

export interface WmsSeedFixture {
  business_id: string;
  branch_id: string;
  warehouse_id: string;
  locations: { inbound: string; stock: string; outbound: string };
  products: [string, string];
  vendor_id: string;
  purchase_order_id: string;
}

export async function ensureSeed(page: Page): Promise<WmsSeedFixture> {
  const url = process.env.VITE_SUPABASE_URL;
  const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anon) {
    throw new Error(
      "ensureSeed: VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY not set — cannot call wms_e2e_ensure_seed",
    );
  }

  const fixture = await page.evaluate(
    async ({ url, anon }) => {
      const storageKey = Object.keys(window.localStorage).find((k) =>
        k.startsWith("sb-") && k.endsWith("-auth-token"),
      );
      const raw = storageKey ? window.localStorage.getItem(storageKey) : null;
      const session = raw ? JSON.parse(raw) : null;
      const accessToken: string | undefined = session?.access_token;
      if (!accessToken) throw new Error("ensureSeed: no Supabase session in localStorage");

      const res = await fetch(`${url}/rest/v1/rpc/wms_e2e_ensure_seed`, {
        method: "POST",
        headers: {
          apikey: anon,
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      if (!res.ok) {
        throw new Error(`wms_e2e_ensure_seed failed: ${res.status} ${await res.text()}`);
      }
      return await res.json();
    },
    { url, anon },
  );

  return fixture as WmsSeedFixture;
}

/**
 * Phase 14d — Wave flow (backend contract).
 *
 * Verifies the full plan → release → cancel arc at the RPC layer
 * against the seeded fixture. Uses a self-contained sales order and
 * pre-seeded stock quant so the spec doesn't depend on 14b/14c side
 * effects.
 *
 * Green criteria:
 *  1. Seed fixture + top up stock at E2E_STOCK for product A.
 *  2. Create an ad-hoc SO for product A (small qty).
 *  3. `create_pick_wave` → wave in state 'draft' with ≥1 wave line.
 *  4. `release_pick_wave` → wave in state 'released', ≥1 pick task
 *     pointing back at the wave with a source_location_id.
 *  5. `cancel_pick_wave` → wave 'cancelled', all pending tasks
 *     cancelled, zero orphan open tasks for the wave.
 *  6. Second `cancel_pick_wave` call is a no-op (idempotent).
 *  7. Rebuild path: a fresh `create_pick_wave` for the same SO
 *     produces a new wave with lines (source qty unchanged because
 *     release only reserves, doesn't fulfill).
 *
 * RPCs exercised: create_pick_wave, release_pick_wave, cancel_pick_wave.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/wave — Phase 14d", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("plan → release → cancel is deterministic and idempotent", async ({ page, context }) => {
    await restoreSupabaseSession(context, page);
    const fixture = await ensureSeed(page);

    const result = await page.evaluate(
      async ({ url, anon, fixture }) => {
        const storageKey = Object.keys(window.localStorage).find(
          (k) => k.startsWith("sb-") && k.endsWith("-auth-token"),
        );
        const raw = storageKey ? window.localStorage.getItem(storageKey) : null;
        const session = raw ? JSON.parse(raw) : null;
        const token: string = session?.access_token;
        if (!token) throw new Error("no supabase session");

        const rest = async (path: string, init: RequestInit & { prefer?: string } = {}) => {
          const { prefer, headers, ...rest } = init;
          const res = await fetch(`${url}${path}`, {
            ...rest,
            headers: {
              apikey: anon,
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              ...(prefer ? { Prefer: prefer } : {}),
              ...((headers as Record<string, string>) ?? {}),
            },
          });
          if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
          return res.status === 204 ? null : await res.json();
        };

        const [{ organization_id: orgId }] = await rest(
          `/rest/v1/businesses?id=eq.${fixture.business_id}&select=organization_id`,
        );

        const productId = fixture.products[0];
        const stockLocationId = fixture.locations.stock;
        const soQty = 3;

        // 1) Top up stock at E2E_STOCK. Upsert-on-identity via merge-duplicates.
        // The identity uindex covers product/location/lot/package/owner; we set
        // lot_number NULL to reuse the same quant across runs and just bump qty.
        const existingQuant: Array<{ id: string; quantity: number; reserved_quantity: number }> =
          await rest(
            `/rest/v1/stock_quants?product_id=eq.${productId}` +
              `&location_id=eq.${stockLocationId}&lot_number=is.null` +
              `&select=id,quantity,reserved_quantity`,
          );
        const targetOnHand = 50;
        if (existingQuant.length === 0) {
          await rest("/rest/v1/stock_quants", {
            method: "POST",
            prefer: "return=minimal",
            body: JSON.stringify({
              organization_id: orgId,
              business_id: fixture.business_id,
              branch_id: fixture.branch_id,
              product_id: productId,
              location_id: stockLocationId,
              quantity: targetOnHand,
              reserved_quantity: 0,
            }),
          });
        } else {
          const q = existingQuant[0];
          if (Number(q.quantity) < targetOnHand) {
            await rest(`/rest/v1/stock_quants?id=eq.${q.id}`, {
              method: "PATCH",
              body: JSON.stringify({ quantity: targetOnHand, reserved_quantity: 0 }),
            });
          }
        }

        // 2) Ad-hoc SO — fresh per run so the wave has something to plan.
        const soNumber = `E2E-SO-W-${Date.now()}`;
        const [so]: Array<{ id: string }> = await rest("/rest/v1/sales_orders", {
          method: "POST",
          prefer: "return=representation",
          body: JSON.stringify({
            organization_id: orgId,
            business_id: fixture.business_id,
            branch_id: fixture.branch_id,
            so_number: soNumber,
            status: "confirmed",
            subtotal: soQty * 10,
            total: soQty * 10,
          }),
        });
        await rest("/rest/v1/sales_order_items", {
          method: "POST",
          prefer: "return=minimal",
          body: JSON.stringify({
            sales_order_id: so.id,
            product_id: productId,
            description: "E2E Product A",
            quantity: soQty,
            quantity_fulfilled: 0,
            unit_price: 10,
            line_total: soQty * 10,
            sort_order: 1,
          }),
        });

        // 3) Plan.
        const plan = await rest("/rest/v1/rpc/create_pick_wave", {
          method: "POST",
          body: JSON.stringify({
            p_warehouse_id: fixture.warehouse_id,
            p_sales_order_ids: [so.id],
            p_notes: "phase14d",
          }),
        });
        const waveId: string = plan.wave_id;
        const [waveDraft] = await rest(
          `/rest/v1/wms_pick_waves?id=eq.${waveId}&select=state,wave_number`,
        );

        // 4) Release.
        const release = await rest("/rest/v1/rpc/release_pick_wave", {
          method: "POST",
          body: JSON.stringify({ p_wave_id: waveId }),
        });
        const [waveReleased] = await rest(
          `/rest/v1/wms_pick_waves?id=eq.${waveId}&select=state,released_at`,
        );
        const tasksAfterRelease: Array<{
          id: string;
          state: string;
          source_location_id: string | null;
          quantity: number;
        }> = await rest(
          `/rest/v1/wms_tasks?source_doc_type=eq.wms_pick_wave` +
            `&source_doc_id=eq.${waveId}&select=id,state,source_location_id,quantity`,
        );

        // 5) Cancel.
        const cancel = await rest("/rest/v1/rpc/cancel_pick_wave", {
          method: "POST",
          body: JSON.stringify({ p_wave_id: waveId, p_reason: "phase14d cancel" }),
        });
        const [waveCancelled] = await rest(
          `/rest/v1/wms_pick_waves?id=eq.${waveId}&select=state`,
        );
        const openTasks: Array<{ id: string }> = await rest(
          `/rest/v1/wms_tasks?source_doc_type=eq.wms_pick_wave` +
            `&source_doc_id=eq.${waveId}` +
            `&state=in.(pending,assigned,in_progress)&select=id`,
        );

        // 6) Cancel again — idempotent.
        const cancelAgain = await rest("/rest/v1/rpc/cancel_pick_wave", {
          method: "POST",
          body: JSON.stringify({ p_wave_id: waveId }),
        });

        // 7) Rebuild path.
        const rebuild = await rest("/rest/v1/rpc/create_pick_wave", {
          method: "POST",
          body: JSON.stringify({
            p_warehouse_id: fixture.warehouse_id,
            p_sales_order_ids: [so.id],
          }),
        });

        return {
          plan,
          waveDraft,
          release,
          waveReleased,
          tasksAfterRelease,
          cancel,
          waveCancelled,
          openTasks,
          cancelAgain,
          rebuild,
        };
      },
      { url: url!, anon: anon!, fixture },
    );

    // Plan.
    expect(result.plan.wave_id).toBeTruthy();
    expect(result.plan.lines_created).toBeGreaterThanOrEqual(1);
    expect(result.waveDraft.state).toBe("draft");

    // Release.
    expect(result.release.tasks_created).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(result.release.task_ids)).toBe(true);
    expect(result.waveReleased.state).toBe("released");
    expect(result.waveReleased.released_at).toBeTruthy();
    expect(result.tasksAfterRelease.length).toBeGreaterThanOrEqual(1);
    const totalPickQty = result.tasksAfterRelease.reduce(
      (s, t) => s + Number(t.quantity),
      0,
    );
    expect(totalPickQty).toBeGreaterThanOrEqual(3);
    // At least one bin-bound task (we seeded stock at E2E_STOCK).
    expect(result.tasksAfterRelease.some((t) => t.source_location_id !== null)).toBe(true);

    // Cancel.
    expect(result.cancel.state).toBe("cancelled");
    expect(result.cancel.cancelled_tasks).toBeGreaterThanOrEqual(
      result.tasksAfterRelease.filter((t) =>
        ["pending", "assigned", "in_progress"].includes(t.state),
      ).length,
    );
    expect(result.waveCancelled.state).toBe("cancelled");
    expect(result.openTasks.length).toBe(0);

    // Idempotency.
    expect(result.cancelAgain).toMatchObject({ state: "cancelled", noop: true });

    // Rebuild — same SO still has open qty because release only reserved.
    expect(result.rebuild.wave_id).toBeTruthy();
    expect(result.rebuild.wave_id).not.toBe(result.plan.wave_id);
    expect(result.rebuild.lines_created).toBeGreaterThanOrEqual(1);
  });
});

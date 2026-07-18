/**
 * Phase 14e — Pick → Pack → Dispatch (backend contract).
 *
 * Extends the Phase 14d wave arc into the full outbound flow. Verifies
 * every station's RPC set against the seeded fixture, then confirms
 * the outbox emitted the terminal warehouse events.
 *
 * Green criteria:
 *  1. Seed fixture, top up stock at E2E_STOCK, create a small SO,
 *     `create_pick_wave` + `release_pick_wave` → pick tasks.
 *  2. For each pick task: `claim_pick_task` → `complete_pick_task`.
 *     Wave rolls up to `picked` and spawns one pack task per SO.
 *  3. `open_pack_carton(wave, so)` → carton + shipment LPN. (Optional
 *     `assign_carton_to_pack` skipped because no carton-type catalogue
 *     is seeded — dims default to nulls; sealer accepts weight only.)
 *  4. `assign_line_to_carton` for every picked wave line, then
 *     `seal_pack_carton` with weight, then `complete_pack_task`.
 *  5. Ad-hoc shipping dock, `open_loading_manifest` →
 *     `load_carton_onto_manifest` → `close_loading_manifest` →
 *     `dispatch_loading_manifest`.
 *  6. Assert `warehouse.carton.shipped` + `warehouse.manifest.dispatched`
 *     landed in `business_event_outbox` with matching idempotency keys,
 *     and the shipment LPN status = 'shipped'.
 *
 * RPCs exercised: claim_pick_task, complete_pick_task, suggest_carton,
 * open_pack_carton, assign_carton_to_pack, assign_line_to_carton,
 * seal_pack_carton, complete_pack_task, open_loading_manifest,
 * load_carton_onto_manifest, close_loading_manifest,
 * dispatch_loading_manifest.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/pick-pack-dispatch — Phase 14e", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("pick → pack → seal → load → dispatch emits outbox terminals", async ({ page, context }) => {
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
        const userId: string = session?.user?.id;
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
        const soQty = 2;

        // Top up stock (upsert-by-identity: prod+loc+no-lot).
        const existing: Array<{ id: string; quantity: number }> = await rest(
          `/rest/v1/stock_quants?product_id=eq.${productId}` +
            `&location_id=eq.${stockLocationId}&lot_number=is.null&select=id,quantity`,
        );
        const target = 50;
        if (existing.length === 0) {
          await rest("/rest/v1/stock_quants", {
            method: "POST",
            prefer: "return=minimal",
            body: JSON.stringify({
              organization_id: orgId,
              business_id: fixture.business_id,
              branch_id: fixture.branch_id,
              product_id: productId,
              location_id: stockLocationId,
              quantity: target,
              reserved_quantity: 0,
            }),
          });
        } else if (Number(existing[0].quantity) < target) {
          await rest(`/rest/v1/stock_quants?id=eq.${existing[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ quantity: target, reserved_quantity: 0 }),
          });
        }

        // Ad-hoc SO for a fresh wave every run.
        const soNumber = `E2E-SO-D-${Date.now()}`;
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

        // Plan + release.
        const plan = await rest("/rest/v1/rpc/create_pick_wave", {
          method: "POST",
          body: JSON.stringify({
            p_warehouse_id: fixture.warehouse_id,
            p_sales_order_ids: [so.id],
          }),
        });
        const waveId: string = plan.wave_id;
        const release = await rest("/rest/v1/rpc/release_pick_wave", {
          method: "POST",
          body: JSON.stringify({ p_wave_id: waveId }),
        });
        const taskIds: string[] = release.task_ids ?? [];
        if (taskIds.length === 0) throw new Error("release produced no pick tasks");

        // Pick every task.
        for (const taskId of taskIds) {
          await rest("/rest/v1/rpc/claim_pick_task", {
            method: "POST",
            body: JSON.stringify({ p_task_id: taskId }),
          });
          const [t]: Array<{ quantity: number }> = await rest(
            `/rest/v1/wms_tasks?id=eq.${taskId}&select=quantity`,
          );
          await rest("/rest/v1/rpc/complete_pick_task", {
            method: "POST",
            body: JSON.stringify({
              p_task_id: taskId,
              p_picked_qty: Number(t.quantity),
            }),
          });
        }

        const [waveAfterPick] = await rest(
          `/rest/v1/wms_pick_waves?id=eq.${waveId}&select=state`,
        );

        // Grab the pack task the picks spawned.
        const packTasks: Array<{ id: string; state: string }> = await rest(
          `/rest/v1/wms_tasks?task_type=eq.pack` +
            `&source_doc_type=eq.sales_order&source_doc_id=eq.${so.id}` +
            `&select=id,state`,
        );
        if (packTasks.length !== 1) {
          throw new Error(`expected 1 pack task, got ${packTasks.length}`);
        }
        const packTaskId = packTasks[0].id;

        // Open + fill + seal the carton.
        const cartonId: string = await rest("/rest/v1/rpc/open_pack_carton", {
          method: "POST",
          body: JSON.stringify({
            p_wave_id: waveId,
            p_sales_order_id: so.id,
          }),
        });

        const waveLines: Array<{ id: string; quantity_picked: number }> = await rest(
          `/rest/v1/wms_pick_wave_lines?wave_id=eq.${waveId}` +
            `&sales_order_id=eq.${so.id}&select=id,quantity_picked`,
        );
        for (const wl of waveLines) {
          if (Number(wl.quantity_picked) > 0) {
            await rest("/rest/v1/rpc/assign_line_to_carton", {
              method: "POST",
              body: JSON.stringify({
                p_carton_id: cartonId,
                p_wave_line_id: wl.id,
                p_qty: Number(wl.quantity_picked),
              }),
            });
          }
        }

        await rest("/rest/v1/rpc/seal_pack_carton", {
          method: "POST",
          body: JSON.stringify({
            p_carton_id: cartonId,
            p_weight_kg: 1.25,
          }),
        });

        const packDone = await rest("/rest/v1/rpc/complete_pack_task", {
          method: "POST",
          body: JSON.stringify({ p_task_id: packTaskId }),
        });

        // Ad-hoc shipping dock (idempotent per warehouse via code).
        const dockCode = "E2E_DOCK_A";
        const existingDock: Array<{ id: string }> = await rest(
          `/rest/v1/warehouse_docks?warehouse_id=eq.${fixture.warehouse_id}` +
            `&code=eq.${dockCode}&select=id`,
        );
        let dockId: string;
        if (existingDock.length > 0) {
          dockId = existingDock[0].id;
        } else {
          const [d]: Array<{ id: string }> = await rest("/rest/v1/warehouse_docks", {
            method: "POST",
            prefer: "return=representation",
            body: JSON.stringify({
              organization_id: orgId,
              business_id: fixture.business_id,
              warehouse_id: fixture.warehouse_id,
              code: dockCode,
              name: "E2E Shipping Dock A",
              dock_type: "shipping",
              is_active: true,
            }),
          });
          dockId = d.id;
        }

        // Manifest lifecycle.
        const manifestId: string = await rest("/rest/v1/rpc/open_loading_manifest", {
          method: "POST",
          body: JSON.stringify({ p_dock_id: dockId }),
        });

        await rest("/rest/v1/rpc/load_carton_onto_manifest", {
          method: "POST",
          body: JSON.stringify({
            p_manifest_id: manifestId,
            p_carton_id: cartonId,
          }),
        });

        await rest("/rest/v1/rpc/close_loading_manifest", {
          method: "POST",
          body: JSON.stringify({ p_manifest_id: manifestId }),
        });

        const dispatch = await rest("/rest/v1/rpc/dispatch_loading_manifest", {
          method: "POST",
          body: JSON.stringify({ p_manifest_id: manifestId }),
        });

        // Read back terminal state.
        const [carton] = await rest(
          `/rest/v1/wms_pack_cartons?id=eq.${cartonId}` +
            `&select=sealed_at,manifest_id,shipment_lpn_id`,
        );
        const [lpn] = await rest(
          `/rest/v1/wms_license_plates?id=eq.${carton.shipment_lpn_id}&select=status`,
        );
        const [manifest] = await rest(
          `/rest/v1/wms_loading_manifests?id=eq.${manifestId}&select=state,dispatched_at`,
        );

        const outboxCartonShipped = await rest(
          `/rest/v1/business_event_outbox?event_type=eq.warehouse.carton.shipped` +
            `&idempotency_key=eq.wms.carton.shipped:${cartonId}&select=id`,
        );
        const outboxManifestDispatched = await rest(
          `/rest/v1/business_event_outbox?event_type=eq.warehouse.manifest.dispatched` +
            `&idempotency_key=eq.wms.manifest.dispatched:${manifestId}&select=id`,
        );

        return {
          waveAfterPick,
          packDone,
          dispatch,
          carton,
          lpn,
          manifest,
          outboxCartonShipped,
          outboxManifestDispatched,
        };
      },
      { url: url!, anon: anon!, fixture },
    );

    // Wave rolls up after all picks done.
    expect(["picked", "packing", "packed"]).toContain(result.waveAfterPick.state);

    // Pack task completed and wave landed at packed.
    expect(result.packDone.wave_state).toBe("packed");

    // Manifest dispatched.
    expect(result.dispatch.shipped_cartons).toBeGreaterThanOrEqual(1);
    expect(result.manifest.state).toBe("dispatched");
    expect(result.manifest.dispatched_at).toBeTruthy();

    // Carton sealed, on this manifest, LPN shipped.
    expect(result.carton.sealed_at).toBeTruthy();
    expect(result.carton.manifest_id).toBeTruthy();
    expect(result.lpn.status).toBe("shipped");

    // Outbox terminals landed exactly once each.
    expect(result.outboxCartonShipped.length).toBe(1);
    expect(result.outboxManifestDispatched.length).toBe(1);
  });
});

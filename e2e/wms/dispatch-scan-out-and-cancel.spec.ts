/**
 * Phase 3.7 §4 — negative branches for the dispatch invariant.
 *
 * Two scenarios, each on its own wave/manifest so they cannot pollute
 * one another:
 *
 *   A. Scan-out shortage — seal two cartons for the same (wave, SO),
 *      load only one onto the manifest, then attempt
 *      `close_loading_manifest`. The RPC MUST raise `WMS_SCAN_SHORTAGE`
 *      and the manifest MUST remain in `loading`. Loading the second
 *      carton clears the block and close/dispatch succeed.
 *
 *   B. Cancellation cascade — open a manifest, load a sealed carton,
 *      then `wms_transition_manifest(..., 'cancelled')`. The carton must
 *      be unbound, the load-task cancelled, and the outbox must carry a
 *      `warehouse.wave.reopened` event keyed on the wave id.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/dispatch-scan-out-and-cancel — Phase 3.7 §4", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("shortage blocks close; cancellation cascades to wave+tasks", async ({ page, context }) => {
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
          const body = res.status === 204 ? null : await res.text();
          if (!res.ok) throw new Error(`${path} → ${res.status} ${body}`);
          return body ? JSON.parse(body) : null;
        };

        const restRaw = async (path: string, init: RequestInit & { prefer?: string } = {}) => {
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
          return { ok: res.ok, status: res.status, body: await res.text() };
        };

        const [{ organization_id: orgId }] = await rest(
          `/rest/v1/businesses?id=eq.${fixture.business_id}&select=organization_id`,
        );

        const productId = fixture.products[0];
        const stockLocationId = fixture.locations.stock;

        // Top up stock so both scenarios have room.
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

        // Idempotent shipping dock.
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

        // -------- Helpers to build a picked+packed wave -----------------
        const buildPackedWave = async (
          soQty: number,
          cartonSplits: number[], // qty per carton
        ) => {
          const soNumber = `E2E-SO-NEG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

          const packTasks: Array<{ id: string }> = await rest(
            `/rest/v1/wms_tasks?task_type=eq.pack` +
              `&source_doc_type=eq.sales_order&source_doc_id=eq.${so.id}` +
              `&select=id`,
          );
          const packTaskId = packTasks[0].id;

          const [wl]: Array<{ id: string; quantity_picked: number }> = await rest(
            `/rest/v1/wms_pick_wave_lines?wave_id=eq.${waveId}` +
              `&sales_order_id=eq.${so.id}&select=id,quantity_picked`,
          );

          const cartonIds: string[] = [];
          for (const qty of cartonSplits) {
            const cartonId: string = await rest("/rest/v1/rpc/open_pack_carton", {
              method: "POST",
              body: JSON.stringify({ p_wave_id: waveId, p_sales_order_id: so.id }),
            });
            await rest("/rest/v1/rpc/assign_line_to_carton", {
              method: "POST",
              body: JSON.stringify({
                p_carton_id: cartonId,
                p_wave_line_id: wl.id,
                p_qty: qty,
              }),
            });
            await rest("/rest/v1/rpc/seal_pack_carton", {
              method: "POST",
              body: JSON.stringify({ p_carton_id: cartonId, p_weight_kg: 1 }),
            });
            cartonIds.push(cartonId);
          }
          await rest("/rest/v1/rpc/complete_pack_task", {
            method: "POST",
            body: JSON.stringify({ p_task_id: packTaskId }),
          });
          return { soId: so.id, waveId, cartonIds };
        };

        // ============ Scenario A — shortage blocks close ================
        const a = await buildPackedWave(2, [1, 1]);
        const manifestA: string = await rest("/rest/v1/rpc/open_loading_manifest", {
          method: "POST",
          body: JSON.stringify({ p_dock_id: dockId }),
        });
        // Load only the first carton.
        await rest("/rest/v1/rpc/load_carton_onto_manifest", {
          method: "POST",
          body: JSON.stringify({ p_manifest_id: manifestA, p_carton_id: a.cartonIds[0] }),
        });
        const shortBefore: string[] = await rest("/rest/v1/rpc/wms_manifest_short_cartons", {
          method: "POST",
          body: JSON.stringify({ p_manifest_id: manifestA }),
        });
        const closeAttempt = await restRaw("/rest/v1/rpc/close_loading_manifest", {
          method: "POST",
          body: JSON.stringify({ p_manifest_id: manifestA }),
        });
        const [manifestAAfterClose] = await rest(
          `/rest/v1/wms_loading_manifests?id=eq.${manifestA}&select=state`,
        );

        // Recover: load second carton, close+dispatch must now succeed.
        await rest("/rest/v1/rpc/load_carton_onto_manifest", {
          method: "POST",
          body: JSON.stringify({ p_manifest_id: manifestA, p_carton_id: a.cartonIds[1] }),
        });
        await rest("/rest/v1/rpc/close_loading_manifest", {
          method: "POST",
          body: JSON.stringify({ p_manifest_id: manifestA }),
        });
        await rest("/rest/v1/rpc/dispatch_loading_manifest", {
          method: "POST",
          body: JSON.stringify({ p_manifest_id: manifestA }),
        });
        const [manifestARecovered] = await rest(
          `/rest/v1/wms_loading_manifests?id=eq.${manifestA}&select=state`,
        );

        // ============ Scenario B — cancellation cascade =================
        const b = await buildPackedWave(1, [1]);
        const manifestB: string = await rest("/rest/v1/rpc/open_loading_manifest", {
          method: "POST",
          body: JSON.stringify({ p_dock_id: dockId }),
        });
        await rest("/rest/v1/rpc/load_carton_onto_manifest", {
          method: "POST",
          body: JSON.stringify({ p_manifest_id: manifestB, p_carton_id: b.cartonIds[0] }),
        });
        // Load-task expected against this manifest.
        const loadTasksBefore: Array<{ id: string; state: string }> = await rest(
          `/rest/v1/wms_tasks?task_type=eq.load` +
            `&source_doc_type=eq.loading_manifest&source_doc_id=eq.${manifestB}` +
            `&select=id,state`,
        );

        await rest("/rest/v1/rpc/wms_transition_manifest", {
          method: "POST",
          body: JSON.stringify({
            p_manifest_id: manifestB,
            p_target_state: "cancelled",
            p_reason: "e2e cancel cascade",
          }),
        });

        const [manifestBCancelled] = await rest(
          `/rest/v1/wms_loading_manifests?id=eq.${manifestB}&select=state`,
        );
        const [cartonBAfter] = await rest(
          `/rest/v1/wms_pack_cartons?id=eq.${b.cartonIds[0]}&select=manifest_id`,
        );
        const loadTasksAfter: Array<{ id: string; state: string }> = await rest(
          `/rest/v1/wms_tasks?task_type=eq.load` +
            `&source_doc_type=eq.loading_manifest&source_doc_id=eq.${manifestB}` +
            `&select=id,state`,
        );
        const waveReopened: Array<{ id: string }> = await rest(
          `/rest/v1/business_event_outbox?event_type=eq.warehouse.wave.reopened` +
            `&payload->>wave_id=eq.${b.waveId}&select=id`,
        );

        return {
          scenarioA: {
            shortBefore,
            closeAttempt,
            stateAfterFailedClose: manifestAAfterClose.state,
            stateAfterRecovery: manifestARecovered.state,
          },
          scenarioB: {
            loadTasksBefore,
            manifestState: manifestBCancelled.state,
            cartonManifestId: cartonBAfter.manifest_id,
            loadTasksAfter,
            waveReopenedCount: waveReopened.length,
          },
        };
      },
      { url: url!, anon: anon!, fixture },
    );

    // ---- Scenario A ------------------------------------------------------
    expect(result.scenarioA.shortBefore.length).toBeGreaterThan(0);
    expect(result.scenarioA.closeAttempt.ok).toBe(false);
    expect(result.scenarioA.closeAttempt.body).toContain("WMS_SCAN_SHORTAGE");
    expect(result.scenarioA.stateAfterFailedClose).toBe("loading");
    expect(result.scenarioA.stateAfterRecovery).toBe("dispatched");

    // ---- Scenario B ------------------------------------------------------
    expect(result.scenarioB.loadTasksBefore.length).toBeGreaterThan(0);
    expect(result.scenarioB.manifestState).toBe("cancelled");
    expect(result.scenarioB.cartonManifestId).toBeNull();
    // Every load task previously bound to this manifest must be cancelled.
    for (const t of result.scenarioB.loadTasksAfter) {
      expect(t.state).toBe("cancelled");
    }
    // Wave-reopened event was emitted at least once for this wave.
    expect(result.scenarioB.waveReopenedCount).toBeGreaterThanOrEqual(1);
  });
});

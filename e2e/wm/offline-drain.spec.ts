/**
 * Phase 14h — Mobile offline-queue drain (RF shell).
 *
 * Green criteria:
 *  1. Seed fixture, top up stock, `create_pick_wave` + `release_pick_wave`
 *     → a pending pick task exists server-side.
 *  2. Navigate to /wm; MobileWarehouseLayout boots `startDrainLoop()`.
 *  3. Programmatically enqueue a `claim_pick_task` call into the
 *     `wm-offline-queue` IndexedDB store (simulating a call made while
 *     offline that never went out on the wire).
 *  4. Trigger the online drain by dispatching a synthetic `online` event.
 *  5. Poll until the queue is empty AND the server-side task advanced to
 *     `assigned` — proves the RPC actually landed, not just that IDB drained.
 *
 * RPCs exercised (via the offline queue): claim_pick_task.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wm/offline-drain — Phase 14h", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("enqueue offline → drain online → server state changed", async ({ page, context }) => {
    await restoreSupabaseSession(context, page);
    const fixture = await ensureSeed(page);

    // Prepare a pending pick task server-side.
    const taskId = await page.evaluate(
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

        // Top up stock so release_pick_wave can allocate.
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

        // Fresh SO + wave so each run has its own pending pick task.
        const soNumber = `E2E-SO-OFFLINE-${Date.now()}`;
        const [so]: Array<{ id: string }> = await rest("/rest/v1/sales_orders", {
          method: "POST",
          prefer: "return=representation",
          body: JSON.stringify({
            organization_id: orgId,
            business_id: fixture.business_id,
            branch_id: fixture.branch_id,
            so_number: soNumber,
            status: "confirmed",
            subtotal: 10,
            total: 10,
          }),
        });
        await rest("/rest/v1/sales_order_items", {
          method: "POST",
          prefer: "return=minimal",
          body: JSON.stringify({
            sales_order_id: so.id,
            product_id: productId,
            description: "E2E Product A",
            quantity: 1,
            quantity_fulfilled: 0,
            unit_price: 10,
            line_total: 10,
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
        await rest("/rest/v1/rpc/release_pick_wave", {
          method: "POST",
          body: JSON.stringify({ p_wave_id: plan.wave_id }),
        });

        const tasks: Array<{ id: string; state: string }> = await rest(
          `/rest/v1/wms_tasks?task_type=eq.pick` +
            `&source_doc_type=eq.wms_pick_wave&source_doc_id=eq.${plan.wave_id}` +
            `&state=eq.pending&select=id,state&limit=1`,
        );
        if (tasks.length === 0) throw new Error("no pending pick task after release_pick_wave");
        return tasks[0].id;
      },
      { url: url!, anon: anon!, fixture },
    );

    // Boot the mobile shell (starts the drain loop + interval).
    await page.goto((process.env.WMS_E2E_BASE_URL ?? "http://localhost:8080") + "/wm");
    await page.waitForLoadState("domcontentloaded");

    // Seed the offline queue directly via IndexedDB, then dispatch `online`
    // to kick the drain immediately (interval is 8s otherwise).
    await page.evaluate(async (taskId) => {
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("wm-offline-queue", 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains("calls")) {
            d.createObjectStore("calls", { keyPath: "id", autoIncrement: true });
          }
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const d = req.result;
          const tx = d.transaction("calls", "readwrite");
          tx.objectStore("calls").add({
            rpc: "claim_pick_task",
            args: { p_task_id: taskId },
            enqueued_at: Date.now(),
            attempts: 0,
            last_error: null,
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      });
      window.dispatchEvent(new Event("online"));
    }, taskId);

    // Poll: queue empty AND server task assigned. startDrainLoop() also
    // ticks every 8s, so this catches whichever fires first.
    const drained = await page.evaluate(
      async ({ url, anon, taskId }) => {
        const storageKey = Object.keys(window.localStorage).find(
          (k) => k.startsWith("sb-") && k.endsWith("-auth-token"),
        );
        const raw = storageKey ? window.localStorage.getItem(storageKey) : null;
        const session = raw ? JSON.parse(raw) : null;
        const token: string = session?.access_token;

        const queueCount = () =>
          new Promise<number>((resolve, reject) => {
            const req = indexedDB.open("wm-offline-queue", 1);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
              const c = req.result.transaction("calls").objectStore("calls").count();
              c.onsuccess = () => resolve(c.result);
              c.onerror = () => reject(c.error);
            };
          });

        const taskState = async () => {
          const res = await fetch(
            `${url}/rest/v1/wms_tasks?id=eq.${taskId}&select=state`,
            {
              headers: {
                apikey: anon,
                Authorization: `Bearer ${token}`,
              },
            },
          );
          const [row] = await res.json();
          return row?.state as string | undefined;
        };

        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const [q, s] = await Promise.all([queueCount(), taskState()]);
          if (q === 0 && s === "assigned") {
            return { queue: q, state: s };
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        // Return whatever we have so the assertion produces useful output.
        return { queue: await queueCount(), state: await taskState() };
      },
      { url: url!, anon: anon!, taskId },
    );

    expect(drained.state).toBe("assigned");
    expect(drained.queue).toBe(0);
  });
});

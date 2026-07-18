/**
 * Phase 14c — Putaway flow (backend contract).
 *
 * Extends the Phase 14b receive contract into put-away. Verifies the
 * full receive → stage → suggest → assign → complete arc at the RPC
 * layer against the seeded fixture.
 *
 * Green criteria:
 *  1. Seed fixture, create + complete a blind GRN (as in 14b).
 *  2. Call `receive_goods_to_wms` → creates a putaway `wms_task`
 *     with an LPN and a destination suggestion.
 *  3. If suggestion left destination null, pin it to the seeded
 *     stock bin (E2E_STOCK) so the test stays deterministic.
 *  4. `assign_wms_task(task_id, user_id)` → state `assigned`.
 *  5. `complete_putaway_task(task_id)` → state `done`, LPN moved.
 *  6. Assert (a) task.state = 'done', (b) LPN.current_location_id =
 *     destination bin, (c) a `stock_quants` row exists at the
 *     destination bin for the seeded product.
 *
 * RPCs exercised: receive_goods_to_wms, suggest_putaway_locations
 * (transitively), assign_wms_task, complete_putaway_task.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/putaway — Phase 14c", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("stage → assign → complete → quants at destination", async ({ page, context }) => {
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

        // Resolve organization_id (some inserts need it explicit).
        const [{ organization_id: orgId }] = await rest(
          `/rest/v1/businesses?id=eq.${fixture.business_id}&select=organization_id`,
        );

        // 1) Blind GRN + one received line (mirrors Phase 14b).
        const poLines: Array<{
          id: string;
          product_id: string;
          description: string;
          quantity: number;
        }> = await rest(
          `/rest/v1/purchase_order_items?purchase_order_id=eq.${fixture.purchase_order_id}` +
            `&select=id,product_id,description,quantity&order=sort_order.asc`,
        );

        const receiptNumber = `E2E-GRN-PA-${Date.now()}`;
        const [grn]: Array<{ id: string }> = await rest("/rest/v1/goods_receipts", {
          method: "POST",
          prefer: "return=representation",
          body: JSON.stringify({
            organization_id: orgId,
            business_id: fixture.business_id,
            branch_id: fixture.branch_id,
            warehouse_id: fixture.warehouse_id,
            purchase_order_id: fixture.purchase_order_id,
            receipt_number: receiptNumber,
            status: "draft",
          }),
        });

        const items: Array<{ id: string; product_id: string }> = await rest(
          "/rest/v1/goods_receipt_items",
          {
            method: "POST",
            prefer: "return=representation",
            body: JSON.stringify(
              poLines.map((l, i) => ({
                goods_receipt_id: grn.id,
                purchase_order_item_id: l.id,
                product_id: l.product_id,
                description: l.description,
                quantity_ordered: l.quantity,
                quantity_received: 0,
                sort_order: i + 1,
              })),
            ),
          },
        );

        const lotNumber = `E2E-LOT-PA-${Date.now()}`;
        const receivedQty = 4;
        const firstItem = items[0];
        await rest("/rest/v1/rpc/record_goods_receipt_line", {
          method: "POST",
          body: JSON.stringify({
            p_grn_item_id: firstItem.id,
            p_quantity_received: receivedQty,
            p_lot_number: lotNumber,
          }),
        });

        const completion = await rest("/rest/v1/rpc/complete_goods_receipt_atomic", {
          method: "POST",
          body: JSON.stringify({ p_grn_id: grn.id, p_user_id: userId }),
        });
        if (!completion?.success) {
          throw new Error(`GRN completion failed: ${JSON.stringify(completion)}`);
        }

        // 2) Stage into WMS — creates putaway task(s) + LPN(s).
        const staging = await rest("/rest/v1/rpc/receive_goods_to_wms", {
          method: "POST",
          body: JSON.stringify({
            p_goods_receipt_id: grn.id,
            p_staging_location_id: fixture.locations.inbound,
          }),
        });
        const taskIds: string[] = staging?.task_ids ?? [];
        if (taskIds.length === 0) throw new Error("no putaway tasks created");
        const taskId = taskIds[0];

        // 3) Pin destination to seeded stock bin if the suggestion left it null.
        const [taskBefore]: Array<{
          destination_location_id: string | null;
          product_id: string;
          lpn_id: string;
        }> = await rest(
          `/rest/v1/wms_tasks?id=eq.${taskId}&select=destination_location_id,product_id,lpn_id`,
        );
        if (!taskBefore.destination_location_id) {
          await rest(`/rest/v1/wms_tasks?id=eq.${taskId}`, {
            method: "PATCH",
            body: JSON.stringify({ destination_location_id: fixture.locations.stock }),
          });
        }
        const destinationId =
          taskBefore.destination_location_id ?? fixture.locations.stock;

        // 4) Assign to self.
        await rest("/rest/v1/rpc/assign_wms_task", {
          method: "POST",
          body: JSON.stringify({ p_task_id: taskId, p_assignee_user_id: userId }),
        });

        // 5) Complete.
        const done = await rest("/rest/v1/rpc/complete_putaway_task", {
          method: "POST",
          body: JSON.stringify({ p_task_id: taskId }),
        });

        // 6) Read back.
        const [taskAfter] = await rest(
          `/rest/v1/wms_tasks?id=eq.${taskId}&select=state,destination_location_id,lpn_id,product_id,lot_number`,
        );
        const [lpn] = await rest(
          `/rest/v1/wms_license_plates?id=eq.${taskAfter.lpn_id}&select=current_location_id,status`,
        );
        const quants = await rest(
          `/rest/v1/stock_quants?location_id=eq.${destinationId}` +
            `&product_id=eq.${taskAfter.product_id}&lot_number=eq.${encodeURIComponent(lotNumber)}&select=quantity`,
        );

        return { taskAfter, lpn, quants, destinationId, done };
      },
      { url: url!, anon: anon!, fixture },
    );

    expect(result.done, `complete_putaway_task returned ${JSON.stringify(result.done)}`).toMatchObject({
      state: "done",
    });
    expect(result.taskAfter.state).toBe("done");
    expect(result.lpn.current_location_id).toBe(result.destinationId);
    expect(result.quants.length).toBeGreaterThanOrEqual(1);
    const totalAtDest = result.quants.reduce(
      (sum: number, q: { quantity: number }) => sum + Number(q.quantity),
      0,
    );
    expect(totalAtDest).toBeGreaterThan(0);
  });
});

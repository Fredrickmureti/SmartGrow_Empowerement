/**
 * Phase 14b — Receive flow (backend contract).
 *
 * This spec verifies the receiving contract at the RPC/data layer rather
 * than driving the wizard UI. UI coverage is Phase 14e's job; here we
 * prove the operational surface an integrator or headless client would
 * touch actually works end-to-end against the seeded fixture.
 *
 * Green criteria:
 *  1. Seed the fixture (warehouse, PO with 2 lines).
 *  2. Insert a blind `goods_receipts` header bound to the seeded PO
 *     and warehouse. Copy the PO lines into `goods_receipt_items`.
 *  3. Record a partial receipt line via `record_goods_receipt_line`.
 *  4. Complete the GRN via `complete_goods_receipt_atomic`.
 *  5. Assert (a) status = 'completed', (b) a `stock_movements` row of
 *     type 'receipt' exists for this GRN with the recorded quantity.
 *
 * TODO(14a.2): introduce a `create_goods_receipt(p_po_id, p_warehouse_id)`
 * wrapper RPC so the direct-insert step below collapses into one call.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/receive — Phase 14b", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("blind receipt → record line → complete → stock movement lands", async ({
    page,
    context,
  }) => {
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

        const rest = async (
          path: string,
          init: RequestInit & { prefer?: string } = {},
        ) => {
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

        // 1) Fetch PO lines seeded by wms_e2e_ensure_seed.
        const poLines: Array<{
          id: string;
          product_id: string;
          description: string;
          quantity: number;
          unit_price: number;
        }> = await rest(
          `/rest/v1/purchase_order_items?purchase_order_id=eq.${fixture.purchase_order_id}` +
            `&select=id,product_id,description,quantity,unit_price&order=sort_order.asc`,
        );
        if (poLines.length < 1) throw new Error("no seeded PO lines");

        // 2) Insert GRN header bound to warehouse + PO. Unique receipt_number per run.
        const receiptNumber = `E2E-GRN-${Date.now()}`;
        const [grn]: Array<{ id: string; organization_id: string; business_id: string }> =
          await rest("/rest/v1/goods_receipts", {
            method: "POST",
            prefer: "return=representation",
            body: JSON.stringify({
              organization_id: null, // trigger/default fills; if not, set from fixture below.
              business_id: fixture.business_id,
              branch_id: fixture.branch_id,
              warehouse_id: fixture.warehouse_id,
              purchase_order_id: fixture.purchase_order_id,
              receipt_number: receiptNumber,
              status: "draft",
            }),
          }).catch(async () => {
            // Retry with organization_id explicit (some schemas require it).
            const org = (
              await rest(
                `/rest/v1/businesses?id=eq.${fixture.business_id}&select=organization_id`,
              )
            )[0]?.organization_id;
            return await rest("/rest/v1/goods_receipts", {
              method: "POST",
              prefer: "return=representation",
              body: JSON.stringify({
                organization_id: org,
                business_id: fixture.business_id,
                branch_id: fixture.branch_id,
                warehouse_id: fixture.warehouse_id,
                purchase_order_id: fixture.purchase_order_id,
                receipt_number: receiptNumber,
                status: "draft",
              }),
            });
          });

        // 3) Copy PO lines into GRN items (quantity_received = 0 initially).
        const items: Array<{ id: string; product_id: string; quantity_ordered: number }> =
          await rest("/rest/v1/goods_receipt_items", {
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
          });

        // 4) Record a partial receipt on line 1.
        const receivedQty = 3;
        const firstItem = items[0];
        await rest("/rest/v1/rpc/record_goods_receipt_line", {
          method: "POST",
          body: JSON.stringify({
            p_grn_item_id: firstItem.id,
            p_quantity_received: receivedQty,
            p_lot_number: `E2E-LOT-${Date.now()}`,
          }),
        });

        // 5) Complete the GRN.
        const completion = await rest("/rest/v1/rpc/complete_goods_receipt_atomic", {
          method: "POST",
          body: JSON.stringify({ p_grn_id: grn.id, p_user_id: session.user.id }),
        });

        // 6) Read back: GRN status + stock_movements row.
        const [grnAfter] = await rest(
          `/rest/v1/goods_receipts?id=eq.${grn.id}&select=status`,
        );
        const movements = await rest(
          `/rest/v1/stock_movements?reference_type=eq.goods_receipt` +
            `&reference_id=eq.${grn.id}&select=product_id,quantity,movement_type`,
        );

        return {
          grn_id: grn.id,
          completion,
          status: grnAfter?.status,
          movements,
          expected_product_id: firstItem.product_id,
          expected_qty: receivedQty,
        };
      },
      { url: url!, anon: anon!, fixture },
    );

    expect(result.completion?.success, `RPC failure: ${JSON.stringify(result.completion)}`).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.movements.length).toBeGreaterThanOrEqual(1);

    const match = result.movements.find(
      (m: { product_id: string; quantity: number; movement_type: string }) =>
        m.product_id === result.expected_product_id &&
        Number(m.quantity) === result.expected_qty &&
        m.movement_type === "receipt",
    );
    expect(match, `no matching stock_movements row for GRN ${result.grn_id}`).toBeTruthy();
  });
});

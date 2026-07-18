/**
 * Phase 14g — Cycle count flow (desktop).
 *
 * Green criteria:
 *  1. Seed fixture, top up stock at E2E_STOCK.
 *  2. `create_count_session(warehouse, 'targeted', [stock_loc])` snapshots
 *     one wms_count_lines row from stock_quants and lands in `counting`.
 *  3. `record_count_scan(session, stock_loc, product, counted=system-1)`
 *     updates the line with a −1 variance and emits
 *     `warehouse.count.recorded`.
 *  4. `approve_count_variance(session)` moves the session `counting → review`.
 *  5. `post_count_session(session)` calls `apply_or_request_stock_adjustment`,
 *     stamps `posted_adjustment_id` on the line, and emits
 *     `warehouse.count.posted` with key `wms.count.posted:<session>`.
 *
 * RPCs exercised: create_count_session, record_count_scan,
 * approve_count_variance, post_count_session.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/count — Phase 14g", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("count session → record scan → approve → post → adjustment + outbox", async ({ page, context }) => {
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
        const target = 20;

        // Ensure a quant of exactly `target` at STOCK / product / no-lot.
        const existing: Array<{ id: string; quantity: number }> = await rest(
          `/rest/v1/stock_quants?product_id=eq.${productId}` +
            `&location_id=eq.${stockLocationId}&lot_number=is.null&select=id,quantity`,
        );
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
        } else if (Number(existing[0].quantity) !== target) {
          await rest(`/rest/v1/stock_quants?id=eq.${existing[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ quantity: target, reserved_quantity: 0 }),
          });
        }

        // 1. Open a targeted count session over just the STOCK bin.
        const sessionId: string = await rest("/rest/v1/rpc/create_count_session", {
          method: "POST",
          body: JSON.stringify({
            p_warehouse_id: fixture.warehouse_id,
            p_strategy: "targeted",
            p_location_ids: [stockLocationId],
            p_notes: "e2e count",
          }),
        });

        const [sessionAfterOpen] = await rest(
          `/rest/v1/wms_count_sessions?id=eq.${sessionId}&select=state`,
        );

        // 2. Record a counted qty of target−1 → variance = −1. Uses the
        //    upsert-by-identity RPC (session, loc, product, lot).
        const scan = await rest("/rest/v1/rpc/record_count_scan", {
          method: "POST",
          body: JSON.stringify({
            p_session_id: sessionId,
            p_location_id: stockLocationId,
            p_product_id: productId,
            p_counted_qty: target - 1,
            p_lot_number: null,
          }),
        });

        // 3. Approve variances → session moves to `review`.
        const approve = await rest("/rest/v1/rpc/approve_count_variance", {
          method: "POST",
          body: JSON.stringify({ p_session_id: sessionId }),
        });

        // 4. Post the session → creates a stock_adjustment via
        //    apply_or_request_stock_adjustment, stamps posted_adjustment_id.
        const post = await rest("/rest/v1/rpc/post_count_session", {
          method: "POST",
          body: JSON.stringify({ p_session_id: sessionId }),
        });

        // Read-back terminal state.
        const [sessionAfterPost] = await rest(
          `/rest/v1/wms_count_sessions?id=eq.${sessionId}&select=state,posted_at`,
        );

        const lines: Array<{
          id: string;
          counted_qty: number | null;
          variance_qty: number | null;
          posted_adjustment_id: string | null;
        }> = await rest(
          `/rest/v1/wms_count_lines?session_id=eq.${sessionId}` +
            `&select=id,counted_qty,variance_qty,posted_adjustment_id`,
        );

        const outboxRecorded = await rest(
          `/rest/v1/business_event_outbox?event_type=eq.warehouse.count.recorded` +
            `&source_doc_type=eq.wms_count_line&source_doc_id=eq.${scan.count_line_id}` +
            `&select=id`,
        );
        const outboxPosted = await rest(
          `/rest/v1/business_event_outbox?event_type=eq.warehouse.count.posted` +
            `&idempotency_key=eq.wms.count.posted:${sessionId}&select=id`,
        );

        return {
          sessionAfterOpen,
          scan,
          approve,
          post,
          sessionAfterPost,
          lines,
          outboxRecorded,
          outboxPosted,
        };
      },
      { url: url!, anon: anon!, fixture },
    );

    // 1. Session opened in counting.
    expect(result.sessionAfterOpen.state).toBe("counting");

    // 2. Scan recorded a variance of −1.
    expect(Number(result.scan.variance_qty)).toBe(-1);

    // 3. Approve moved the session to review.
    expect(result.approve.state).toBe("review");

    // 4. Post landed the session at `posted` with an adjustment stamped
    //    on every variance line.
    expect(result.sessionAfterPost.state).toBe("posted");
    expect(result.sessionAfterPost.posted_at).toBeTruthy();
    expect(result.post.variance_count).toBeGreaterThanOrEqual(1);

    const varianceLines = result.lines.filter(
      (l) => l.counted_qty !== null && Number(l.variance_qty ?? 0) !== 0,
    );
    expect(varianceLines.length).toBeGreaterThanOrEqual(1);
    for (const l of varianceLines) {
      expect(l.posted_adjustment_id).toBeTruthy();
    }

    // 5. Outbox terminals landed.
    expect(result.outboxRecorded.length).toBeGreaterThanOrEqual(1);
    expect(result.outboxPosted.length).toBe(1);
  });
});

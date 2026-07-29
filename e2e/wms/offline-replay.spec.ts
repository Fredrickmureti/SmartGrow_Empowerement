/**
 * Phase 3.8 — Offline scan-replay idempotency.
 *
 * Simulates an RF client that captures a receiving-line scan while
 * offline, comes back online, and replays the same
 * `(device_id, client_scan_id)` tuple multiple times. The server MUST:
 *
 *   - Insert exactly ONE `wms_receiving_lines` row for the scan.
 *   - Emit exactly ONE `warehouse.receiving.line_captured` outbox row.
 *   - Return `replayed: true` on the duplicate submissions.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/offline-replay — Phase 3.8", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("same (device_id, client_scan_id) replayed 3× → one line, one outbox row", async ({
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

        // 1. Open a receiving session.
        const [session_row] = await rest(`/rest/v1/wms_receiving_sessions`, {
          method: "POST",
          prefer: "return=representation",
          body: JSON.stringify({
            organization_id: null,
            business_id: fixture.business_id,
            branch_id: fixture.branch_id,
            warehouse_id: fixture.warehouse_id,
            dock_id: null,
            source_doc_type: "purchase_order",
            source_doc_id: fixture.purchase_order_id,
            state: "open",
          }),
        });
        const session_id: string = session_row.id;

        // 2. Prepare a stable (device_id, client_scan_id) pair.
        const device_id = `e2e-replay-${crypto.randomUUID()}`;
        const client_scan_id = crypto.randomUUID();

        // 3. Fire the RPC three times back-to-back.
        const results: Array<{ line_id: string; replayed: boolean }> = [];
        for (let i = 0; i < 3; i++) {
          const body = await rest(`/rest/v1/rpc/wms_capture_receiving_line`, {
            method: "POST",
            body: JSON.stringify({
              p_session_id: session_id,
              p_product_id: fixture.products[0],
              p_received_qty: 5,
              p_expected_qty: 5,
              p_client_scan_id: client_scan_id,
              p_device_id: device_id,
            }),
          });
          results.push(body);
        }

        // 4. Count physical rows for this scan.
        const lines: Array<{ id: string }> = await rest(
          `/rest/v1/wms_receiving_lines?session_id=eq.${session_id}` +
            `&product_id=eq.${fixture.products[0]}&select=id`,
        );

        // 5. Count outbox emissions keyed to that line.
        const line_ids = lines.map((l) => l.id).join(",");
        const outbox: Array<{ idempotency_key: string }> = line_ids
          ? await rest(
              `/rest/v1/business_event_outbox?event_type=eq.warehouse.receiving.line_captured` +
                `&source_doc_id=in.(${line_ids})&select=idempotency_key`,
            )
          : [];

        return { results, line_count: lines.length, outbox_count: outbox.length };
      },
      { url, anon, fixture },
    );

    // First call is fresh, next two are replays. Exactly one line + one outbox row.
    expect(result.results[0].replayed).toBe(false);
    expect(result.results[1].replayed).toBe(true);
    expect(result.results[2].replayed).toBe(true);
    const distinctLineIds = new Set(result.results.map((r) => r.line_id));
    expect(distinctLineIds.size).toBe(1);
    expect(result.line_count).toBe(1);
    expect(result.outbox_count).toBe(1);
  });
});

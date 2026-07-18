/**
 * Phase 14f — QC inspection lifecycle (backend contract).
 *
 * Extends the seed fixture with stock at E2E_STOCK, opens three QC
 * inspections for the same product, then drives the accept / reject /
 * cancel branches and asserts:
 *   - stock_movements posted only when a physical move is expected
 *     (open, accept, reject-with-scrap disposition — cancel is inert),
 *   - inspection state transitions land correctly,
 *   - business_event_outbox carries the terminal `warehouse.qc.*` event
 *     for each branch exactly once with the ADR-0076 idempotency key
 *     `wms.qc.<inspection_id>:<state>`.
 *
 * RPCs exercised: open_qc_inspection, accept_qc_inspection,
 * reject_qc_inspection, cancel_qc_inspection.
 */
import { test, expect } from "@playwright/test";
import { ensureSeed } from "../support/seed";
import { restoreSupabaseSession, authAvailable } from "../support/auth";

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

test.describe("wms/qc — Phase 14f", () => {
  test.beforeAll(() => {
    if (!authAvailable()) test.skip(true, "no injected supabase session");
    if (!url || !anon) test.skip(true, "supabase env vars missing");
  });

  test("accept / reject / cancel branches emit correct events + moves", async ({
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

        // Top up stock at E2E_STOCK so open_qc_inspection has something to
        // physically park in QUARANTINE. Enough to cover all three inspections.
        const target = 60;
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
        } else if (Number(existing[0].quantity) < target) {
          await rest(`/rest/v1/stock_quants?id=eq.${existing[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ quantity: target, reserved_quantity: 0 }),
          });
        }

        // Open three inspections against ad-hoc source doc IDs (crypto.randomUUID)
        // so each branch is isolated end-to-end.
        const openInsp = async () => {
          const insp = await rest("/rest/v1/rpc/open_qc_inspection", {
            method: "POST",
            body: JSON.stringify({
              p_warehouse_id: fixture.warehouse_id,
              p_source_doc_type: "manual",
              p_source_doc_id: crypto.randomUUID(),
              p_product_id: productId,
              p_quantity: 5,
              p_sample_strategy: "full",
            }),
          });
          return insp as { id: string; state: string };
        };

        const inspAccept = await openInsp();
        const inspReject = await openInsp();
        const inspCancel = await openInsp();

        // --- Accept branch ---
        const accepted = await rest("/rest/v1/rpc/accept_qc_inspection", {
          method: "POST",
          body: JSON.stringify({
            p_inspection_id: inspAccept.id,
            p_accepted_qty: 5,
            p_notes: "E2E accept",
          }),
        });

        // --- Reject branch (scrap disposition → moves to SCRAP loc) ---
        const rejected = await rest("/rest/v1/rpc/reject_qc_inspection", {
          method: "POST",
          body: JSON.stringify({
            p_inspection_id: inspReject.id,
            p_rejected_qty: 5,
            p_disposition: "scrap",
            p_notes: "E2E reject",
          }),
        });

        // --- Cancel branch (no stock effect, non-idempotent — expect throw on 2nd call) ---
        const cancelled = await rest("/rest/v1/rpc/cancel_qc_inspection", {
          method: "POST",
          body: JSON.stringify({
            p_inspection_id: inspCancel.id,
            p_reason: "E2E cancel",
          }),
        });

        let secondCancelThrew = false;
        try {
          await rest("/rest/v1/rpc/cancel_qc_inspection", {
            method: "POST",
            body: JSON.stringify({
              p_inspection_id: inspCancel.id,
              p_reason: "E2E cancel again",
            }),
          });
        } catch {
          secondCancelThrew = true;
        }

        // Read-back: stock movement rows keyed by inspection id.
        const movementsFor = async (inspId: string) =>
          (await rest(
            `/rest/v1/stock_movements?reference_type=eq.wms_qc_inspection` +
              `&reference_id=eq.${inspId}&select=id,movement_type,quantity,source_location_id,destination_location_id&order=created_at.asc`,
          )) as Array<{
            movement_type: string;
            quantity: number;
            source_location_id: string | null;
            destination_location_id: string | null;
          }>;

        const acceptMoves = await movementsFor(inspAccept.id);
        const rejectMoves = await movementsFor(inspReject.id);
        const cancelMoves = await movementsFor(inspCancel.id);

        // Read-back: outbox events keyed by inspection id (source_doc_id).
        const eventsFor = async (inspId: string) =>
          (await rest(
            `/rest/v1/business_event_outbox?source_doc_type=eq.wms_qc_inspection` +
              `&source_doc_id=eq.${inspId}&select=event_type,idempotency_key&order=created_at.asc`,
          )) as Array<{ event_type: string; idempotency_key: string }>;

        const acceptEvents = await eventsFor(inspAccept.id);
        const rejectEvents = await eventsFor(inspReject.id);
        const cancelEvents = await eventsFor(inspCancel.id);

        return {
          accepted,
          rejected,
          cancelled,
          secondCancelThrew,
          acceptMoves,
          rejectMoves,
          cancelMoves,
          acceptEvents,
          rejectEvents,
          cancelEvents,
        };
      },
      { url, anon, fixture },
    );

    // Terminal inspection states.
    expect(result.accepted.state).toBe("accepted");
    expect(result.rejected.state).toBe("rejected");
    expect(result.cancelled.state).toBe("cancelled");
    expect(result.secondCancelThrew).toBe(true);

    // open + accept => 4 movement rows (2 pairs: stock↔quarantine, quarantine↔stock).
    expect(result.acceptMoves.length).toBe(4);
    // open + reject(scrap) => 4 movement rows (2 pairs: stock↔quarantine, quarantine↔scrap).
    expect(result.rejectMoves.length).toBe(4);
    // open + cancel => 2 movement rows from open only; cancel posts nothing.
    expect(result.cancelMoves.length).toBe(2);

    // Terminal outbox events landed once each with ADR-0076 key shape.
    const acceptTypes = result.acceptEvents.map((e) => e.event_type);
    expect(acceptTypes).toContain("warehouse.qc.opened");
    expect(acceptTypes).toContain("warehouse.qc.accepted");
    expect(acceptTypes.filter((t) => t === "warehouse.qc.accepted").length).toBe(1);
    expect(
      result.acceptEvents.some((e) =>
        e.idempotency_key.startsWith("wms.qc.") &&
        e.idempotency_key.endsWith(":accepted"),
      ),
    ).toBe(true);

    const rejectTypes = result.rejectEvents.map((e) => e.event_type);
    expect(rejectTypes).toContain("warehouse.qc.rejected");
    expect(rejectTypes.filter((t) => t === "warehouse.qc.rejected").length).toBe(1);
    expect(
      result.rejectEvents.some((e) =>
        e.idempotency_key.startsWith("wms.qc.") &&
        e.idempotency_key.endsWith(":rejected"),
      ),
    ).toBe(true);

    const cancelTypes = result.cancelEvents.map((e) => e.event_type);
    expect(cancelTypes).toContain("warehouse.qc.cancelled");
    expect(cancelTypes.filter((t) => t === "warehouse.qc.cancelled").length).toBe(1);
  });
});

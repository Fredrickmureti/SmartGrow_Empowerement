/**
 * Phase D.3 · ASN CSV import — batch handler.
 *
 * Groups validated CSV rows by `shipment_number` and inserts one
 * `inbound_shipments` header + N `inbound_shipment_items` per group.
 *
 * Design principles:
 *  - Pure orchestration over existing tables. No new RPC.
 *  - Tenant scoping (organization_id / business_id / branch_id) is passed
 *    in explicitly — never resolved from client state inside this module,
 *    so it stays testable and reusable across pages.
 *  - Product SKU resolution is deferred to a caller-supplied resolver
 *    (mirrors `ContactResolver` in the PO importer). Missing SKUs skip the
 *    whole shipment they belong to; other groups still import.
 *  - Shipments are created in `dispatched` status by default. Callers can
 *    override via `defaultStatus` if they want to import drafts.
 *  - Idempotency: if a shipment_number already exists for the business,
 *    the group is skipped and reported.
 *
 * The returned `BatchImportFn` is drop-in compatible with `useImport`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BatchImportFn, ImportResults } from "@/hooks/useImport";

export interface AsnProductResolver {
  /** Return the internal product id (uuid) for a caller-provided SKU, or null if unknown. */
  resolveBySku(sku: string): Promise<string | null>;
}

export interface AsnImportContext {
  supabase: SupabaseClient<any, "public", any>;
  organizationId: string;
  businessId: string;
  branchId: string | null;
  createdBy: string | null;
  productResolver: AsnProductResolver;
  /** Optional: resolve a PO number to `purchase_orders.id`. Missing PO is not fatal. */
  resolvePoByNumber?: (poNumber: string) => Promise<string | null>;
  /** Default shipment status when the CSV does not carry one. */
  defaultStatus?: "draft" | "dispatched" | "in_transit";
}

const toIsoOrNull = (v: unknown): string | null => {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const toDateOrNull = (v: unknown): string | null => {
  const iso = toIsoOrNull(v);
  return iso ? iso.slice(0, 10) : null;
};

const pushError = (
  results: ImportResults,
  rowIndex: number,
  data: Record<string, any>,
  message: string,
) => {
  results.errors.push({ rowIndex, data, errors: message });
};

export function createAsnBatchImportHandler(ctx: AsnImportContext): BatchImportFn {
  return async (rows) => {
    const results: ImportResults = { total: rows.length, imported: 0, skipped: 0, errors: [] };
    if (rows.length === 0) return results;

    // ── Group rows by shipment_number ────────────────────────────────────
    const groups = new Map<string, { rowIndex: number; data: Record<string, any> }[]>();
    rows.forEach((row, idx) => {
      const key = String(row.shipment_number || "").trim();
      if (!key) {
        results.skipped += 1;
        pushError(results, idx, row, "Missing shipment_number");
        return;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push({ rowIndex: idx, data: row });
    });

    // Pre-check for existing shipment numbers scoped to this business.
    const shipmentNumbers = Array.from(groups.keys());
    const existing = new Set<string>();
    if (shipmentNumbers.length > 0) {
      const { data: dupRows } = await ctx.supabase
        .from("inbound_shipments")
        .select("shipment_number")
        .eq("business_id", ctx.businessId)
        .in("shipment_number", shipmentNumbers);
      for (const r of dupRows ?? []) existing.add((r as any).shipment_number);
    }

    for (const [shipmentNumber, groupRows] of groups) {
      const first = groupRows[0];
      const firstRow = first.data;
      if (existing.has(shipmentNumber)) {
        results.skipped += groupRows.length;
        pushError(
          results,
          first.rowIndex,
          firstRow,
          `Shipment ${shipmentNumber} already exists — skipped`,
        );
        continue;
      }

      // Resolve every SKU up-front so we can skip the whole shipment cleanly
      // rather than partially inserting.
      const resolvedItems: Array<{ row: Record<string, any>; productId: string }> = [];
      let groupError: string | null = null;
      for (const gr of groupRows) {
        const sku = String(gr.data.product_sku || "").trim();
        if (!sku) {
          groupError = `Shipment ${shipmentNumber}: a line is missing product SKU`;
          break;
        }
        const productId = await ctx.productResolver.resolveBySku(sku);
        if (!productId) {
          groupError = `Shipment ${shipmentNumber}: unknown SKU "${sku}"`;
          break;
        }
        resolvedItems.push({ row: gr.data, productId });
      }
      if (groupError) {
        results.skipped += groupRows.length;
        pushError(results, first.rowIndex, firstRow, groupError);
        continue;
      }

      const purchaseOrderId = firstRow.po_number && ctx.resolvePoByNumber
        ? await ctx.resolvePoByNumber(String(firstRow.po_number).trim())
        : null;

      const status = ctx.defaultStatus ?? "dispatched";
      const dispatchedAt = toIsoOrNull(firstRow.dispatched_at)
        ?? (status !== "draft" ? new Date().toISOString() : null);

      // ── Insert header ────────────────────────────────────────────────
      const { data: header, error: headerErr } = await ctx.supabase
        .from("inbound_shipments")
        .insert({
          organization_id: ctx.organizationId,
          business_id: ctx.businessId,
          branch_id: ctx.branchId,
          purchase_order_id: purchaseOrderId,
          shipment_number: shipmentNumber,
          status,
          carrier: firstRow.carrier || null,
          tracking_number: firstRow.tracking_number || null,
          dispatched_at: dispatchedAt,
          expected_arrival_at: toIsoOrNull(firstRow.expected_arrival),
          notes: firstRow.notes || null,
          created_by: ctx.createdBy,
        })
        .select("id")
        .single();
      if (headerErr || !header) {
        results.skipped += groupRows.length;
        pushError(
          results,
          first.rowIndex,
          firstRow,
          `Shipment ${shipmentNumber}: ${headerErr?.message ?? "insert failed"}`,
        );
        continue;
      }

      // ── Insert lines ─────────────────────────────────────────────────
      const items = resolvedItems.map(({ row, productId }, idx) => ({
        organization_id: ctx.organizationId,
        business_id: ctx.businessId,
        branch_id: ctx.branchId,
        shipment_id: header.id,
        product_id: productId,
        expected_quantity: Number(row.expected_quantity) || 0,
        expected_lot_number: row.expected_lot_number || null,
        expected_expiry_date: toDateOrNull(row.expected_expiry_date),
        expected_manufacture_date: toDateOrNull(row.expected_manufacture_date),
        notes: row.notes || null,
        sort_order: idx,
      }));
      const { error: itemsErr } = await ctx.supabase
        .from("inbound_shipment_items")
        .insert(items);
      if (itemsErr) {
        // Roll the header back so we don't leave orphaned shipments.
        await ctx.supabase.from("inbound_shipments").delete().eq("id", header.id);
        results.skipped += groupRows.length;
        pushError(
          results,
          first.rowIndex,
          firstRow,
          `Shipment ${shipmentNumber} lines: ${itemsErr.message}`,
        );
        continue;
      }

      results.imported += groupRows.length;
    }

    return results;
  };
}

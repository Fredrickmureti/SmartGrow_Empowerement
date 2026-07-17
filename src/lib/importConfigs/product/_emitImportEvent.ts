/**
 * ADR-0074 event emission helper — used by every product-import batch
 * handler to publish a `product.import.completed` (or `.failed`) event
 * into `business_event_outbox` via the `emit_business_event` RPC.
 *
 * Client cannot INSERT into `business_event_outbox` directly (RLS denies
 * all client writes). The RPC is SECURITY DEFINER, whitelists
 * `product.import.*` and `stock.*` event types, and enforces workspace
 * membership via `user_business_access`.
 *
 * Idempotency: the caller supplies a `batchId` (uuid, generated once per
 * handler invocation) which becomes both `source_doc_id` and part of the
 * `idempotency_key`, so a retried import cannot re-emit the same event.
 */
import { supabase } from "@/integrations/supabase/client";
import type { BatchResult } from "./_resolveProduct";

export type ProductImportKind =
  | "master"
  | "barcode"
  | "batch"
  | "warehouse_stock"
  | "price"
  | "supplier";

export interface EmitImportEventArgs {
  orgId: string;
  businessId: string;
  kind: ProductImportKind;
  batchId: string;
  result: BatchResult;
  branchId?: string | null;
  warehouseId?: string | null;
}

export async function emitProductImportCompleted(args: EmitImportEventArgs): Promise<void> {
  const { orgId, businessId, kind, batchId, result, branchId, warehouseId } = args;
  const eventType = result.errors.length > 0
    ? "product.import.completed_with_errors"
    : "product.import.completed";

  try {
    await supabase.rpc("emit_business_event" as any, {
      p_org_id: orgId,
      p_business_id: businessId,
      p_event_type: eventType,
      p_source_doc_type: `product_import.${kind}`,
      p_source_doc_id: batchId,
      p_idempotency_key: `product_import:${kind}:${batchId}`,
      p_payload: {
        kind,
        total: result.total,
        imported: result.imported,
        skipped: result.skipped,
        error_count: result.errors.length,
        sample_errors: result.errors.slice(0, 5).map((e) => ({
          row: e.rowIndex,
          message: e.errors,
        })),
      } as any,
      p_branch_id: branchId ?? null,
      p_warehouse_id: warehouseId ?? null,
    });
  } catch (err) {
    // Emission is best-effort — never fault the import because the
    // outbox insert failed. Log for observability.
    // eslint-disable-next-line no-console
    console.warn(`[product-import] outbox emit failed for ${kind}:`, err);
  }
}

export function newBatchId(): string {
  // crypto.randomUUID is available in all modern browsers + Deno + Node ≥ 19.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: RFC4122-ish v4 from Math.random (only if the platform is ancient).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
/**
 * Thin typed wrappers around the requisition lifecycle + release RPCs.
 *
 * Every RPC below is SECURITY DEFINER, business-scoped, atomic, and
 * emits a `procurement.requisition.*` outbox event with idempotency key
 * `procurement.requisition.<state>:<uuid>`. The browser NEVER mutates
 * `purchase_requisitions` state columns directly: RLS only permits the
 * requester to touch their own draft, and `_pr_guard_header` /
 * `_pr_guard_item` reject any lifecycle write that did not originate in
 * one of these functions.
 *
 * Approval is routed through the canonical governance engine
 * (`approval_route('requisition.approve', ...)`); when a policy gates the
 * action the decision must be taken in the approvals inbox and is mirrored
 * back by `_mirror_approval_to_requisition`. `approve_requisition` remains
 * as the ungated path and still enforces segregation of duties.
 *
 * Currency is NOT an input — the server derives it from the business base
 * currency. Supplier currency appears later, on the quotation and the PO.
 */
import { supabase } from "@/integrations/supabase/client";

export interface RequisitionLineInput {
  product_id?: string | null;
  description: string;
  uom_id?: string | null;
  quantity: number;
  estimated_unit_price: number;
  need_by_date?: string | null;
  suggested_supplier_id?: string | null;
  contract_line_id?: string | null;
  destination_branch_id?: string | null;
  destination_warehouse_id?: string | null;
  notes?: string | null;
}

export async function createPurchaseRequisition(input: {
  businessId: string;
  needByDate?: string | null;
  priority?: "low" | "normal" | "high" | "urgent";
  costCenter?: string | null;
  analyticAccountId?: string | null;
  projectId?: string | null;
  destinationBranchId?: string | null;
  destinationWarehouseId?: string | null;
  justification?: string | null;
  notes?: string | null;
  lines: RequisitionLineInput[];
}) {
  const { data, error } = await (supabase as any).rpc(
    "create_purchase_requisition",
    {
      p_business_id: input.businessId,
      p_need_by_date: input.needByDate ?? null,
      p_priority: input.priority ?? "normal",
      p_currency: null, // derived server-side from the business base currency
      p_cost_center: input.costCenter ?? null,
      p_justification: input.justification ?? null,
      p_notes: input.notes ?? null,
      p_lines: input.lines,
      p_analytic_account_id: input.analyticAccountId ?? null,
      p_project_id: input.projectId ?? null,
      p_destination_branch_id: input.destinationBranchId ?? null,
      p_destination_warehouse_id: input.destinationWarehouseId ?? null,
    },
  );
  if (error) throw error;
  return data as string;
}

async function unwrap(res: { data: any; error: any }) {
  if (res.error) throw res.error;
  if (res.data && typeof res.data === "object" && "success" in res.data) {
    if (!res.data.success) {
      throw new Error(res.data.error ?? "Operation failed");
    }
  }
  return res.data;
}

export async function submitRequisition(id: string) {
  return unwrap(
    await (supabase as any).rpc("submit_requisition", {
      p_requisition_id: id,
    }),
  );
}

export async function approveRequisition(id: string, comment?: string) {
  return unwrap(
    await (supabase as any).rpc("approve_requisition", {
      p_requisition_id: id,
      p_comment: comment ?? null,
    }),
  );
}

export async function rejectRequisition(id: string, reason: string) {
  return unwrap(
    await (supabase as any).rpc("reject_requisition", {
      p_requisition_id: id,
      p_reason: reason,
    }),
  );
}

export async function cancelRequisition(id: string, reason?: string) {
  return unwrap(
    await (supabase as any).rpc("cancel_requisition", {
      p_requisition_id: id,
      p_reason: reason ?? null,
    }),
  );
}

/** Amend an approved-but-unordered requisition: back to draft, version + 1. */
export async function amendRequisition(id: string, reason?: string) {
  return unwrap(
    await (supabase as any).rpc("requisition_amend", {
      _requisition_id: id,
      _reason: reason ?? null,
    }),
  );
}

/** Release selected approved lines to a new draft RFQ. */
export async function requisitionCreateRfq(
  id: string,
  lineIds?: string[] | null,
  deadline?: string | null,
) {
  return unwrap(
    await (supabase as any).rpc("requisition_create_rfq", {
      _requisition_id: id,
      _line_ids: lineIds && lineIds.length > 0 ? lineIds : null,
      _deadline: deadline || null,
    }),
  );
}

/** Release selected approved lines straight to a draft purchase order. */
export async function requisitionConvertToPo(
  id: string,
  supplierId: string,
  lineIds?: string[] | null,
) {
  return unwrap(
    await (supabase as any).rpc("requisition_convert_to_po", {
      _requisition_id: id,
      _supplier_id: supplierId,
      _line_ids: lineIds && lineIds.length > 0 ? lineIds : null,
    }),
  );
}

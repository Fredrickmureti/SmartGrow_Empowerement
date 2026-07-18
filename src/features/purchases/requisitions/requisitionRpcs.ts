/**
 * Thin typed wrappers around the P3 requisition lifecycle RPCs.
 *
 * Every RPC below is SECURITY DEFINER, business-scoped, atomic, and
 * emits a `procurement.requisition.*` outbox event with idempotency key
 * `procurement.requisition.<state>:<uuid>`. UI never mutates
 * `purchase_requisitions` state columns directly.
 *
 * Self-approval is blocked in `approve_requisition` (requester_id !=
 * auth.uid()) and mirrored by the SoD conflict rows registered in the
 * P3 migration (`requisition.approve` vs `requisition.submit`).
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
  notes?: string | null;
}

export async function createPurchaseRequisition(input: {
  businessId: string;
  needByDate?: string | null;
  priority?: "low" | "normal" | "high" | "urgent";
  currency?: string;
  costCenter?: string | null;
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
      p_currency: input.currency ?? "USD",
      p_cost_center: input.costCenter ?? null,
      p_justification: input.justification ?? null,
      p_notes: input.notes ?? null,
      p_lines: input.lines,
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

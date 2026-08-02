/**
 * Return order (header) data access.
 *
 * Header state changes go exclusively through `wms_transition_return` /
 * `wms_close_return`; the client never writes `state` directly.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { ReturnKind, ReturnOrder, ReturnState } from "./returnsModel";

export const RETURN_ORDERS_KEY = "wms-return-orders";

const ORDER_COLUMNS =
  "id, organization_id, business_id, branch_id, warehouse_id, code, rma_reference, return_kind, state, source_doc_type, source_doc_id, customer_id, vendor_id, appointment_id, dock_id, trailer_visit_id, carrier_id, tracking_reference, finance_doc_type, finance_doc_id, credit_note_id, disposition_summary, expected_at, received_at, posted_at, closed_at, notes, row_version, created_at";

export function useReturnOrders(params: {
  businessId: string | undefined;
  warehouseId?: string | null;
  states?: ReturnState[];
}) {
  const { businessId, warehouseId, states } = params;
  return useQuery({
    queryKey: [RETURN_ORDERS_KEY, businessId, warehouseId ?? "all", states?.join(",") ?? "all"],
    enabled: !!businessId,
    queryFn: async () => {
      let query = supabase
        .from("wms_return_orders" as any)
        .select(ORDER_COLUMNS)
        .eq("business_id", businessId!)
        .order("created_at", { ascending: false });
      if (warehouseId) query = query.eq("warehouse_id", warehouseId);
      if (states?.length) query = query.in("state", states);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as ReturnOrder[];
    },
  });
}

export function useReturnOrder(returnId: string | null | undefined) {
  return useQuery({
    queryKey: [RETURN_ORDERS_KEY, "one", returnId],
    enabled: !!returnId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_return_orders" as any)
        .select(ORDER_COLUMNS)
        .eq("id", returnId!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as ReturnOrder | null;
    },
  });
}

function useInvalidateReturns() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: [RETURN_ORDERS_KEY] });
    qc.invalidateQueries({ queryKey: ["wms-return-lines"] });
  };
}

export interface CreateReturnInput {
  organizationId: string;
  businessId: string;
  warehouseId: string;
  code: string;
  returnKind: ReturnKind;
  rmaReference?: string | null;
  sourceDocType?: string | null;
  sourceDocId?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  carrierId?: string | null;
  trackingReference?: string | null;
  appointmentId?: string | null;
  expectedAt?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}

export function useCreateReturnOrder() {
  const invalidate = useInvalidateReturns();
  return useMutation({
    mutationFn: async (input: CreateReturnInput) => {
      const { data, error } = await supabase
        .from("wms_return_orders" as any)
        .insert({
          organization_id: input.organizationId,
          business_id: input.businessId,
          warehouse_id: input.warehouseId,
          code: input.code,
          return_kind: input.returnKind,
          rma_reference: input.rmaReference ?? null,
          source_doc_type: input.sourceDocType ?? null,
          source_doc_id: input.sourceDocId ?? null,
          customer_id: input.customerId ?? null,
          vendor_id: input.vendorId ?? null,
          carrier_id: input.carrierId ?? null,
          tracking_reference: input.trackingReference ?? null,
          appointment_id: input.appointmentId ?? null,
          expected_at: input.expectedAt ?? null,
          notes: input.notes ?? null,
          created_by: input.createdBy ?? null,
        })
        .select("id")
        .single();
      if (error) throw error;
      return data as unknown as { id: string };
    },
    onSuccess: invalidate,
  });
}

export function useTransitionReturn() {
  const invalidate = useInvalidateReturns();
  return useMutation({
    mutationFn: async (input: {
      returnId: string;
      toState: ReturnState;
      rowVersion: number;
      reason?: string | null;
      payload?: Record<string, unknown>;
    }) => {
      const { data, error } = await supabase.rpc("wms_transition_return" as any, {
        p_return_id: input.returnId,
        p_to_state: input.toState,
        p_row_version: input.rowVersion,
        p_reason: input.reason ?? null,
        p_payload: input.payload ?? {},
      });
      if (error) throw error;
      return data as { row_version: number; state: ReturnState };
    },
    onSuccess: invalidate,
  });
}

/** Close guard lives server-side: every line must be dispositioned and posted. */
export function useCloseReturn() {
  const invalidate = useInvalidateReturns();
  return useMutation({
    mutationFn: async (input: { returnId: string; rowVersion: number; reason?: string | null }) => {
      const { data, error } = await supabase.rpc("wms_close_return" as any, {
        p_return_id: input.returnId,
        p_row_version: input.rowVersion,
        p_reason: input.reason ?? null,
      });
      if (error) throw error;
      return data as { row_version: number; state: ReturnState };
    },
    onSuccess: invalidate,
  });
}

/** Link the finance document (sales/purchase return + credit note) to the RMA. */
export function useLinkReturnFinance() {
  const invalidate = useInvalidateReturns();
  return useMutation({
    mutationFn: async (input: {
      returnId: string;
      financeDocType: string;
      financeDocId: string;
      creditNoteId?: string | null;
    }) => {
      const { error } = await supabase
        .from("wms_return_orders" as any)
        .update({
          finance_doc_type: input.financeDocType,
          finance_doc_id: input.financeDocId,
          credit_note_id: input.creditNoteId ?? null,
        })
        .eq("id", input.returnId);
      if (error) throw error;
      return true;
    },
    onSuccess: invalidate,
  });
}

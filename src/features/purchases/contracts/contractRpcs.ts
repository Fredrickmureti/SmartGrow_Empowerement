/**
 * Thin typed wrappers around the P2 contract lifecycle RPCs.
 *
 * All are SECURITY DEFINER, business-scoped, and emit `contract.*`
 * outbox events. UI never writes contract state columns directly.
 */
import { supabase } from "@/integrations/supabase/client";

export interface ContractLineInput {
  product_id?: string | null;
  description?: string | null;
  uom_id?: string | null;
  unit_price?: number | null;
  min_quantity?: number | null;
  max_quantity?: number | null;
  ceiling_quantity?: number | null;
  ceiling_value?: number | null;
  sort_order?: number | null;
}

export async function createProcurementContract(input: {
  businessId: string;
  supplierId: string;
  contractNumber?: string | null;
  title: string;
  kind: string;
  currency: string;
  startDate: string;
  endDate: string;
  ceilingValue?: number | null;
  lines?: ContractLineInput[];
  notes?: string | null;
}) {
  const { data, error } = await (supabase as any).rpc(
    "create_procurement_contract",
    {
      p_business_id: input.businessId,
      p_supplier_id: input.supplierId,
      p_contract_number: input.contractNumber ?? null,
      p_title: input.title,
      p_kind: input.kind,
      p_currency: input.currency,
      p_start_date: input.startDate,
      p_end_date: input.endDate,
      p_ceiling_value: input.ceilingValue ?? null,
      p_lines: input.lines ?? [],
      p_notes: input.notes ?? null,
    },
  );
  if (error) throw error;
  return data as string;
}

export async function activateProcurementContract(contractId: string) {
  const { data, error } = await (supabase as any).rpc(
    "activate_procurement_contract",
    { p_contract_id: contractId },
  );
  if (error) throw error;
  return data;
}

export async function amendProcurementContract(
  contractId: string,
  patch: {
    title?: string | null;
    endDate?: string | null;
    ceilingValue?: number | null;
    notes?: string | null;
  },
) {
  const { data, error } = await (supabase as any).rpc(
    "amend_procurement_contract",
    {
      p_contract_id: contractId,
      p_title: patch.title ?? null,
      p_end_date: patch.endDate ?? null,
      p_ceiling_value: patch.ceilingValue ?? null,
      p_notes: patch.notes ?? null,
    },
  );
  if (error) throw error;
  return data;
}

export async function terminateProcurementContract(
  contractId: string,
  reason: string,
) {
  const { data, error } = await (supabase as any).rpc(
    "terminate_procurement_contract",
    { p_contract_id: contractId, p_reason: reason },
  );
  if (error) throw error;
  return data;
}

/**
 * Thin typed wrappers around the procurement contract lifecycle RPCs.
 *
 * All are SECURITY DEFINER, business-scoped, and emit
 * `procurement.contract.*` outbox events. The contract tables carry no
 * INSERT/UPDATE/DELETE policies at all: these RPCs are the only write path.
 */
import { supabase } from "@/integrations/supabase/client";

export interface ContractRpcResult {
  success: boolean;
  error?: string;
  contract_id?: string;
  contract_number?: string;
  approval_request_id?: string | null;
  exchange_rate?: number | null;
  version?: number;
  amendment_number?: number;
  status?: string;
}

function unwrap(data: unknown): ContractRpcResult {
  const result = (data ?? {}) as ContractRpcResult;
  if (result.success === false) throw new Error(result.error ?? "Operation failed");
  return result;
}

export interface ContractLineInput {
  product_id?: string | null;
  description?: string | null;
  uom_id?: string | null;
  unit_price?: number | null;
  supplier_sku?: string | null;
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
  priceTolerancePercent?: number | null;
  priceToleranceAmount?: number | null;
  enforceItemCoverage?: boolean;
}) {
  const { data, error } = await (supabase as any).rpc("create_procurement_contract", {
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
    p_price_tolerance_percent: input.priceTolerancePercent ?? 0,
    p_price_tolerance_amount: input.priceToleranceAmount ?? 0,
    p_enforce_item_coverage: input.enforceItemCoverage ?? false,
  });
  if (error) throw error;
  return unwrap(data);
}

/** Draft → pending approval, routed through the shared approval engine. */
export async function submitProcurementContract(contractId: string) {
  const { data, error } = await (supabase as any).rpc("submit_procurement_contract", {
    p_contract_id: contractId,
  });
  if (error) throw error;
  return unwrap(data);
}

/** Approve + activate. Stamps the FX rate in force; enforces segregation of duties. */
export async function activateProcurementContract(contractId: string) {
  const { data, error } = await (supabase as any).rpc("activate_procurement_contract", {
    p_contract_id: contractId,
  });
  if (error) throw error;
  return unwrap(data);
}

export type ContractAmendmentKind =
  | "extension"
  | "ceiling_change"
  | "price_change"
  | "scope_change"
  | "terms_change"
  | "renewal"
  | "other";

/**
 * Effective-dated amendment: writes the changes, snapshots a new version and
 * records the amendment so historical terms stay reconstructable.
 */
export async function amendProcurementContract(
  contractId: string,
  input: {
    kind: ContractAmendmentKind;
    effectiveOn: string;
    reason?: string | null;
    changes: {
      title?: string | null;
      end_date?: string | null;
      ceiling_value?: number | null;
      notes?: string | null;
      price_tolerance_percent?: number | null;
      price_tolerance_amount?: number | null;
      lines?: Array<{
        id: string;
        unit_price?: number | null;
        ceiling_quantity?: number | null;
        ceiling_value?: number | null;
        effective_from?: string | null;
        effective_to?: string | null;
      }>;
    };
  },
) {
  const changes = Object.fromEntries(
    Object.entries(input.changes).filter(([, v]) => v !== null && v !== undefined && v !== ""),
  );
  const { data, error } = await (supabase as any).rpc("amend_procurement_contract", {
    p_contract_id: contractId,
    p_kind: input.kind,
    p_effective_on: input.effectiveOn,
    p_changes: changes,
    p_reason: input.reason ?? null,
  });
  if (error) throw error;
  return unwrap(data);
}

export type ContractStateAction =
  | "suspend"
  | "resume"
  | "terminate"
  | "close"
  | "withdraw";

export async function setProcurementContractState(
  contractId: string,
  action: ContractStateAction,
  reason?: string | null,
) {
  const { data, error } = await (supabase as any).rpc("set_procurement_contract_state", {
    p_contract_id: contractId,
    p_action: action,
    p_reason: reason ?? null,
  });
  if (error) throw error;
  return unwrap(data);
}

export async function terminateProcurementContract(contractId: string, reason: string) {
  return setProcurementContractState(contractId, "terminate", reason);
}

export async function renewProcurementContract(
  contractId: string,
  newEndDate: string,
  newCeilingValue?: number | null,
) {
  const { data, error } = await (supabase as any).rpc("renew_procurement_contract", {
    p_contract_id: contractId,
    p_new_end_date: newEndDate,
    p_new_ceiling_value: newCeilingValue ?? null,
  });
  if (error) throw error;
  return unwrap(data);
}

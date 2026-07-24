/**
 * useLegalOrders — Phase 5 read hook backed by the `public.legal_orders`
 * view. The view resolves the legal-behaviour pack columns
 * (calc_model, priority_class, protected_earnings_rule,
 *  aggregate_cap_membership, remittance_schedule_ref, evidence_requirements,
 *  completion_rule, reporting_binding_ref) alongside the raw
 * `employee_garnishments` row + linked authority metadata.
 *
 * Write paths (create/edit/status transitions/documents) still go through
 * `useGarnishments` — this hook is read-only and is the single source of
 * truth for the new UI surfaces (dashboard, edit form defaults,
 * effective-window preview) so we cannot drift from the resolved values
 * the payroll engine actually uses at runtime.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";

export type LegalOrderCalcModel =
  | "fixed_amount"
  | "percent_disposable"
  | "lesser_of_fixed_or_pct"
  | "percent_gross"
  | "progressive";

export type LegalOrderCapMembership =
  | "counts_toward_aggregate"
  | "exempt"
  | "standalone_ceiling";

export type LegalOrderCompletionRule =
  | "until_total_owed_met"
  | "until_end_date"
  | "manual_release_only"
  | "until_authority_release";

export type LegalOrderStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "active"
  | "suspended"
  | "satisfied"
  | "released"
  | "expired"
  | "terminated_unsatisfied";

export interface LegalOrderRow {
  id: string;
  organization_id: string;
  business_id: string | null;
  employee_id: string;
  employment_id: string | null;

  // Resolved from authority + pack
  kind_code: string;
  authority_id: string | null;
  authority_name: string | null;
  case_reference: string | null;

  // Legal-behaviour (from pack; overrideable per-order)
  calc_model: LegalOrderCalcModel;
  cap_rule: LegalOrderCalcModel; // legacy field — mirrored for compat
  priority: number | null;
  priority_class: number | null;
  aggregate_cap_membership: LegalOrderCapMembership;
  aggregate_cap_exempt: boolean;
  protected_earnings_rule: Record<string, unknown> | null;
  minimum_take_home_amount: number | null;
  remittance_schedule_ref: string | null;
  evidence_requirements: Record<string, unknown> | null;
  completion_rule: LegalOrderCompletionRule;
  reporting_binding_ref: string | null;
  legal_behavior_pack_id: string | null;

  // Amounts
  fixed_amount: number | null;
  percent_of_disposable: number | null;
  total_owed: number | null;
  total_paid: number | null;
  total_accrued: number | null;

  // Window
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;

  // Status
  status: LegalOrderStatus;
  status_changed_at: string | null;
  status_changed_by: string | null;
  status_reason: string | null;

  // Payee remittance method. Identity / bank / reference now live on
  // legal_recipients master (ADR-0093, Phase R4b).
  payee_payment_method_id: string | null;

  // Evidence (legacy single-doc; versioned files live in legal_order_documents)
  document_url: string | null;
  document_filename: string | null;

  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const VIEW_SELECT = "*";

export function useLegalOrders(opts?: { employeeId?: string | null; status?: LegalOrderStatus | LegalOrderStatus[] | null }) {
  const { currentOrg: organization } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = organization?.id ?? null;
  const bizId = currentBusiness?.id ?? null;
  const employeeId = opts?.employeeId ?? null;
  const statusFilter = opts?.status ?? null;

  return useQuery<LegalOrderRow[]>({
    queryKey: ["legal_orders", orgId, bizId, employeeId, statusFilter],
    enabled: !!orgId,
    queryFn: async () => {
      let q = (supabase as any)
        .from("legal_orders")
        .select(VIEW_SELECT)
        .eq("organization_id", orgId!)
        .order("priority", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false });
      if (bizId) q = q.eq("business_id", bizId);
      if (employeeId) q = q.eq("employee_id", employeeId);
      if (statusFilter) {
        if (Array.isArray(statusFilter)) q = q.in("status", statusFilter);
        else q = q.eq("status", statusFilter);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as LegalOrderRow[];
    },
  });
}

export function useLegalOrder(id: string | null | undefined) {
  return useQuery<LegalOrderRow | null>({
    queryKey: ["legal_order", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("legal_orders")
        .select(VIEW_SELECT)
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as LegalOrderRow | null;
    },
  });
}

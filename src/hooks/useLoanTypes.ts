import { normalizeError } from "@/services/resilience";
/**
 * Loan Types — configurable per organization (and optionally per business).
 *
 * The wizard, the engine, and the GL resolver all consume this list;
 * nothing about loans is hardcoded as an enum anywhere else.
 *
 * Phase F: the interface now exposes the full policy surface
 * (tenure bounds, deduction priority, dual control, collateral/consent,
 * skip caps, interest_method, all four GL accounts, write-off account) so
 * the settings cockpit can render and edit every field that Phases A–E
 * actually enforce.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { toast } from "sonner";

export type LoanKind = "loan" | "salary_advance" | "emergency" | "asset" | "custom";
export type RepaymentMethod =
  | "fixed_installment"
  | "fixed_amount"
  | "percent_of_net"
  | "one_off_next_payroll";
export type InterestMethod = "flat" | "reducing_balance" | "none";
export type SkipInterestTreatment = "accrue" | "waive" | "capitalise";
export type SkipScheduleAdjustment = "push_end" | "rebalance" | "shorten";

export interface LoanTypeFieldSpec {
  key: string;
  label: string;
  type: "number" | "text" | "date";
  required?: boolean;
  helper?: string;
}

export interface LoanType {
  id: string;
  organization_id: string;
  business_id: string | null;
  code: string;
  name: string;
  kind: LoanKind;
  description: string | null;

  // Behaviour toggles
  requires_interest: boolean;
  requires_schedule: boolean;
  requires_approval: boolean;
  requires_dual_approval: boolean | null;
  requires_collateral: boolean | null;
  requires_consent: boolean | null;
  allow_topup: boolean | null;
  allow_restructure: boolean | null;
  dual_control_writeoff: boolean | null;

  // Defaults
  default_repayment_method: RepaymentMethod;
  default_installments: number | null;
  default_max_pct_of_net: number | null;
  default_min_net_pay_floor: number | null;
  interest_method: InterestMethod | null;

  // Policy bounds
  min_installments: number | null;
  max_installments: number | null;
  min_principal: number | null;
  max_principal: number | null;
  min_tenure_months: number | null;
  max_tenure_months: number | null;
  deduction_priority: number | null;

  // Skip policy
  allow_skip: boolean | null;
  max_skips_per_loan: number | null;
  max_skips_per_calendar_year: number | null;
  min_gap_between_skips_days: number | null;
  interest_treatment_on_skip: SkipInterestTreatment | null;
  schedule_adjustment_on_skip: SkipScheduleAdjustment | null;

  // GL wiring
  gl_receivable_account_id: string | null;
  gl_disbursement_clearing_account_id: string | null;
  interest_income_account_id: string | null;
  writeoff_account_id: string | null;

  // Payroll / dynamic
  salary_rule_code: string | null;
  is_active: boolean;
  dynamic_field_schema: { fields?: LoanTypeFieldSpec[] } | null;
}

export type LoanTypeInput = Partial<Omit<LoanType, "id" | "organization_id">> &
  Pick<LoanType, "code" | "name" | "kind" | "default_repayment_method">;

const NULLABLE_FIELDS: (keyof LoanType)[] = [
  "description", "business_id",
  "requires_dual_approval", "requires_collateral", "requires_consent",
  "allow_topup", "allow_restructure", "dual_control_writeoff",
  "default_installments", "default_max_pct_of_net", "default_min_net_pay_floor",
  "interest_method",
  "min_installments", "max_installments", "min_principal", "max_principal",
  "min_tenure_months", "max_tenure_months", "deduction_priority",
  "allow_skip", "max_skips_per_loan", "max_skips_per_calendar_year",
  "min_gap_between_skips_days", "interest_treatment_on_skip", "schedule_adjustment_on_skip",
  "gl_receivable_account_id", "gl_disbursement_clearing_account_id",
  "interest_income_account_id", "writeoff_account_id",
  "salary_rule_code",
];

export function useLoanTypes() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();

  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id ?? null;

  const { data: loanTypes = [], isLoading } = useQuery({
    queryKey: ["loan_types", orgId, businessId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("loan_types")
        .select("*")
        .eq("organization_id", orgId)
        .order("name");
      if (error) throw error;
      const rows = (data || []) as LoanType[];
      return rows.filter(
        (t) => !t.business_id || t.business_id === businessId,
      );
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["loan_types", orgId, businessId] });

  const upsert = useMutation({
    mutationFn: async (input: LoanTypeInput & { id?: string }) => {
      if (!orgId) throw new Error("No organization");
      const payload: any = {
        organization_id: orgId,
        business_id: input.business_id ?? null,
        code: input.code,
        name: input.name,
        kind: input.kind,
        description: input.description ?? null,

        requires_interest: input.requires_interest ?? false,
        requires_schedule: input.requires_schedule ?? true,
        requires_approval: input.requires_approval ?? true,
        requires_dual_approval: input.requires_dual_approval ?? null,
        requires_collateral: input.requires_collateral ?? null,
        requires_consent: input.requires_consent ?? null,
        allow_topup: input.allow_topup ?? null,
        allow_restructure: input.allow_restructure ?? null,
        dual_control_writeoff: input.dual_control_writeoff ?? null,

        default_repayment_method: input.default_repayment_method,
        default_installments: input.default_installments ?? null,
        default_max_pct_of_net: input.default_max_pct_of_net ?? null,
        default_min_net_pay_floor: input.default_min_net_pay_floor ?? null,
        interest_method: input.interest_method ?? null,

        min_installments: input.min_installments ?? null,
        max_installments: input.max_installments ?? null,
        min_principal: input.min_principal ?? null,
        max_principal: input.max_principal ?? null,
        min_tenure_months: input.min_tenure_months ?? null,
        max_tenure_months: input.max_tenure_months ?? null,
        deduction_priority: input.deduction_priority ?? null,

        allow_skip: input.allow_skip ?? null,
        max_skips_per_loan: input.max_skips_per_loan ?? null,
        max_skips_per_calendar_year: input.max_skips_per_calendar_year ?? null,
        min_gap_between_skips_days: input.min_gap_between_skips_days ?? null,
        interest_treatment_on_skip: input.interest_treatment_on_skip ?? null,
        schedule_adjustment_on_skip: input.schedule_adjustment_on_skip ?? null,

        gl_receivable_account_id: input.gl_receivable_account_id ?? null,
        gl_disbursement_clearing_account_id: input.gl_disbursement_clearing_account_id ?? null,
        interest_income_account_id: input.interest_income_account_id ?? null,
        writeoff_account_id: input.writeoff_account_id ?? null,

        salary_rule_code: input.salary_rule_code ?? null,
        is_active: input.is_active ?? true,
        dynamic_field_schema: input.dynamic_field_schema ?? {},
      };
      if (input.id) {
        const { data, error } = await (supabase as any)
          .from("loan_types").update(payload).eq("id", input.id).select().single();
        if (error) throw error;
        return data;
      }
      const { data, error } = await (supabase as any)
        .from("loan_types").insert(payload).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => { invalidate(); toast.success("Loan type saved"); },
    onError: (e: any) => toast.error(normalizeError(e).message || "Failed to save loan type"),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await (supabase as any).from("loan_types").update({ is_active: false }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); toast.success("Loan type deactivated"); },
  });

  const seedDefaults = useMutation({
    mutationFn: async () => {
      if (!orgId) throw new Error("No organization");
      const { error } = await (supabase as any).rpc("seed_default_loan_types", { _org_id: orgId });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); toast.success("Default loan types seeded"); },
  });

  return {
    loanTypes,
    activeLoanTypes: loanTypes.filter((t) => t.is_active),
    isLoading,
    upsertLoanType: upsert.mutateAsync,
    removeLoanType: remove.mutateAsync,
    seedDefaultLoanTypes: seedDefaults.mutateAsync,
  };
}

// Silence unused warning in case linter is strict.
void NULLABLE_FIELDS;

/**
 * Phase F — Aggregate operational stats per loan_type. Powers the KPI strip
 * and per-row usage badges on LoanTypesSettings. Runs one small query per
 * dependent table and joins in memory so we don't need any new SQL views.
 */
export interface LoanTypeStats {
  activeLoansByType: Record<string, number>;
  pendingLoansByType: Record<string, number>;
  outstandingByType: Record<string, number>;
  writeOffsByType: Record<string, number>;
  totalOutstanding: number;
  totalActiveLoans: number;
  totalPending: number;
  readinessFindings: {
    loan_type_gl_missing: number;
    loan_schedule_missing: number;
    loan_writeoff_missing: number;
  };
}

export function useLoanTypeStats() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;

  return useQuery<LoanTypeStats>({
    queryKey: ["loan_type_stats", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const empty: LoanTypeStats = {
        activeLoansByType: {},
        pendingLoansByType: {},
        outstandingByType: {},
        writeOffsByType: {},
        totalOutstanding: 0,
        totalActiveLoans: 0,
        totalPending: 0,
        readinessFindings: {
          loan_type_gl_missing: 0,
          loan_schedule_missing: 0,
          loan_writeoff_missing: 0,
        },
      };
      if (!orgId) return empty;

      // Loans grouped in memory (avoids a new RPC).
      const { data: loans } = await (supabase as any)
        .from("employee_loans")
        .select("loan_type_id, status, outstanding_balance")
        .eq("organization_id", orgId);

      for (const l of (loans || []) as any[]) {
        const tid = l.loan_type_id as string | null;
        if (!tid) continue;
        if (l.status === "active") {
          empty.activeLoansByType[tid] = (empty.activeLoansByType[tid] || 0) + 1;
          empty.outstandingByType[tid] = (empty.outstandingByType[tid] || 0) + Number(l.outstanding_balance || 0);
          empty.totalActiveLoans += 1;
          empty.totalOutstanding += Number(l.outstanding_balance || 0);
        } else if (l.status === "pending") {
          empty.pendingLoansByType[tid] = (empty.pendingLoansByType[tid] || 0) + 1;
          empty.totalPending += 1;
        } else if (l.status === "written_off") {
          empty.writeOffsByType[tid] = (empty.writeOffsByType[tid] || 0) + 1;
        }
      }

      // Phase C readiness findings (loan-scoped rules). Best-effort — table
      // may be empty if evaluate_payroll_readiness hasn't been triggered yet.
      try {
        const { data: findings } = await (supabase as any)
          .from("payroll_readiness_findings")
          .select("reason, status, payroll_readiness_rules!inner(code)")
          .eq("organization_id", orgId)
          .in("status", ["fail", "warn"]);
        for (const f of (findings || []) as any[]) {
          const code = f.payroll_readiness_rules?.code as string | undefined;
          if (code === "loan_type.gl_complete") empty.readinessFindings.loan_type_gl_missing += 1;
          else if (code === "loan.schedule_present") empty.readinessFindings.loan_schedule_missing += 1;
          else if (code === "loan_type.writeoff_account_present") empty.readinessFindings.loan_writeoff_missing += 1;
        }
      } catch { /* non-fatal */ }

      return empty;
    },
  });
}

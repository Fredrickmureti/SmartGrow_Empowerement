import { normalizeError } from "@/services/resilience";
/**
 * Loan Types — configurable per organization (and optionally per business).
 *
 * The wizard, the engine, and the GL resolver all consume this list;
 * nothing about loans is hardcoded as an enum anywhere else.
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
  requires_interest: boolean;
  requires_schedule: boolean;
  requires_approval: boolean;
  default_repayment_method: RepaymentMethod;
  default_installments: number | null;
  default_max_pct_of_net: number | null;
  default_min_net_pay_floor: number | null;
  min_installments: number | null;
  max_installments: number | null;
  min_principal: number | null;
  max_principal: number | null;
  gl_receivable_account_id: string | null;
  gl_disbursement_clearing_account_id: string | null;
  salary_rule_code: string | null;
  is_active: boolean;
  dynamic_field_schema: { fields?: LoanTypeFieldSpec[] } | null;
}

export type LoanTypeInput = Partial<Omit<LoanType, "id" | "organization_id">> &
  Pick<LoanType, "code" | "name" | "kind" | "default_repayment_method">;

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
        default_repayment_method: input.default_repayment_method,
        default_installments: input.default_installments ?? null,
        default_max_pct_of_net: input.default_max_pct_of_net ?? null,
        default_min_net_pay_floor: input.default_min_net_pay_floor ?? null,
        min_installments: input.min_installments ?? null,
        max_installments: input.max_installments ?? null,
        min_principal: input.min_principal ?? null,
        max_principal: input.max_principal ?? null,
        gl_receivable_account_id: input.gl_receivable_account_id ?? null,
        gl_disbursement_clearing_account_id: input.gl_disbursement_clearing_account_id ?? null,
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

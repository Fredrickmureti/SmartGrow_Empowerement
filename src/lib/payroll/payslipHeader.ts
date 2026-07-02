/**
 * Country-agnostic payslip header model.
 *
 * Single source of truth consumed by the payslip PDF (server-side),
 * the admin PayslipDetailDialog, and the employee portal MyPayslips
 * view. The shape is whatever `public.payslip_header(payslip_id)`
 * returns — see migration. Country specifics live in the
 * `employee_statutory_identifiers`, `organization_statutory_identifiers`,
 * and `pack_requirements` tables — NEVER in this file or its consumers.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { labelForIdentifier } from "@/hooks/employees/useEmployeeStatutoryIdentifiers";

export interface PayslipStatutoryId {
  identifier_type: string;
  identifier_value: string | null;
  country_code: string | null;
  /** Resolved display label (humanised, no country branching). */
  label: string;
  /**
   * 'consumed' = a rule that ran on this payslip depends on this identifier.
   * 'declared' = on file but no rule on this run referenced it.
   * Renderers should down-rank or hide 'declared' IDs on the employee-facing
   * surface. See ADR-0036 §I9.
   */
  relevance: "consumed" | "declared";
}

export interface PayslipRequiredId {
  identifier_type: string;
  label: string;
  is_required: boolean;
}

export interface PayslipHeaderModel {
  employer: {
    organization_id: string;
    name: string | null;
    country_code: string | null;
    statutory_ids: PayslipStatutoryId[];
  };
  employee: {
    id: string;
    name: string;
    employee_number: string | null;
    department: string | null;
    position: string | null;
    bank_name: string | null;
    bank_branch: string | null;
    bank_account_masked: string | null;
    country_code: string | null;
    statutory_ids: PayslipStatutoryId[];
  };
  period: {
    payroll_number: string | null;
    pay_period_start: string | null;
    pay_period_end: string | null;
    payment_date: string | null;
    currency: string | null;
  };
  pack: {
    country_code: string | null;
    required: PayslipRequiredId[];
  };
  notes: Array<{ severity: "warning" | "info"; message: string }>;
}

function hydrateIds(raw: any[], packLabels: Record<string, string>): PayslipStatutoryId[] {
  return (raw ?? []).map((r) => ({
    identifier_type: r.identifier_type,
    identifier_value: r.identifier_value ?? null,
    country_code: r.country_code ?? null,
    // Pack-declared label wins over the generic client-side humaniser so
    // a localization pack can ship a fully localised display string
    // (e.g. "RSSB Number (Rwanda)") without any code change.
    label:
      packLabels[r.identifier_type] ??
      labelForIdentifier(r.identifier_type),
    // Backwards-compat: older payslip_header builds omit `relevance`. Treat
    // unknown values as 'consumed' so we don't suddenly blank an existing
    // employer/employee block when the RPC hasn't been redeployed yet.
    relevance: r.relevance === "declared" ? "declared" : "consumed",
  }));
}

export function hydratePayslipHeader(raw: any): PayslipHeaderModel | null {
  if (!raw || raw.error) return null;
  const packLabels: Record<string, string> = {};
  for (const r of (raw.pack?.required ?? []) as any[]) {
    if (r?.identifier_type && r?.label) packLabels[r.identifier_type] = r.label;
  }
  return {
    employer: {
      ...raw.employer,
      statutory_ids: hydrateIds(raw.employer?.statutory_ids ?? [], packLabels),
    },
    employee: {
      ...raw.employee,
      statutory_ids: hydrateIds(raw.employee?.statutory_ids ?? [], packLabels),
    },
    period: raw.period ?? {},
    pack: {
      country_code: raw.pack?.country_code ?? null,
      required: (raw.pack?.required ?? []).map((r: any) => ({
        identifier_type: r.identifier_type,
        label: r.label ?? labelForIdentifier(r.identifier_type),
        is_required: !!r.is_required,
      })),
    },
    notes: raw.notes ?? [],
  };
}

export function usePayslipHeader(payslipId: string | null | undefined) {
  return useQuery({
    queryKey: ["payslip-header", payslipId],
    enabled: !!payslipId,
    queryFn: async (): Promise<PayslipHeaderModel | null> => {
      const { data, error } = await (supabase as any).rpc("payslip_header", {
        _payslip_id: payslipId,
      });
      if (error) throw error;
      return hydratePayslipHeader(data);
    },
    staleTime: 30_000,
  });
}

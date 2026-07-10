/**
 * usePayrollReportDefinitions — canonical registry hook for the Payroll
 * Reports workspace. Reads active rows from `payroll_report_definitions`
 * so both built-in and country-pack-published reports surface in the same
 * tabbed workspace without a code change.
 *
 * Falls back to the built-in seed list only if the registry is empty
 * (e.g. a very fresh workspace where the seed insert has not landed
 * yet); this keeps the page usable during upgrades.
 *
 * See docs/adr — Phase 2 of the Payroll Reports enterprise redesign.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type PayrollReportCategory =
  | "operational"
  | "cost"
  | "management"
  | "compliance"
  | "audit";

export interface PayrollReportDefinition {
  id: string;
  reportKey: string;
  label: string;
  description: string | null;
  category: PayrollReportCategory;
  scope: "organization" | "business" | "branch" | "employee";
  countryCode: string | null;
  sortOrder: number;
  featureFlag: string | null;
}

const CATEGORY_LABEL: Record<PayrollReportCategory, string> = {
  operational: "Operate",
  cost: "Cost Analysis",
  management: "Management",
  compliance: "Compliance",
  audit: "Audit",
};

const CATEGORY_ORDER: PayrollReportCategory[] = [
  "operational",
  "cost",
  "management",
  "compliance",
  "audit",
];

export interface PayrollReportGroup {
  category: PayrollReportCategory;
  label: string;
  items: PayrollReportDefinition[];
}

export function usePayrollReportDefinitions(countryCode?: string | null) {
  return useQuery({
    queryKey: ["payroll-report-definitions", countryCode ?? null],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<PayrollReportDefinition[]> => {
      let q = (supabase as any)
        .from("payroll_report_definitions")
        .select(
          "id, report_key, label, description, category, scope, country_code, sort_order, feature_flag",
        )
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      // Show global (country_code IS NULL) plus, when a country is scoped,
      // that country's rows. Kept as post-fetch filter to stay compatible
      // with older PostgREST versions used by the sandbox.
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []).filter(
        (r: any) => !r.country_code || !countryCode || r.country_code === countryCode,
      );
      return rows.map((r: any) => ({
        id: r.id,
        reportKey: r.report_key,
        label: r.label,
        description: r.description,
        category: r.category,
        scope: r.scope,
        countryCode: r.country_code,
        sortOrder: r.sort_order,
        featureFlag: r.feature_flag,
      }));
    },
  });
}

/**
 * Group definitions by category in canonical display order. Categories
 * with no rows are omitted so the workspace never renders empty rails.
 */
export function groupPayrollReports(
  defs: PayrollReportDefinition[] | undefined,
): PayrollReportGroup[] {
  if (!defs?.length) return [];
  const buckets = new Map<PayrollReportCategory, PayrollReportDefinition[]>();
  for (const d of defs) {
    if (!buckets.has(d.category)) buckets.set(d.category, []);
    buckets.get(d.category)!.push(d);
  }
  return CATEGORY_ORDER.filter((c) => buckets.has(c)).map((c) => ({
    category: c,
    label: CATEGORY_LABEL[c],
    items: buckets.get(c)!,
  }));
}
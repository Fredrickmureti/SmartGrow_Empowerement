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

export type PayrollReportOwnerKind =
  | "payroll_engine"
  | "finance"
  | "audit"
  | "localization_pack"
  | "management"
  | "hr";

export type PayrollReportPreviewKind =
  | "table"
  | "summary"
  | "matrix"
  | "dashboard"
  | "statutory_form"
  | "certificate";

export interface PayrollReportExportFormat {
  format: string;      // pdf | csv | xlsx | official_csv | xml | json
  label: string;
  isPrimary?: boolean;
}

export interface PayrollReportParameters {
  period?: boolean;
  run?: boolean;
  employee?: boolean;
  branch?: boolean;
  currencyBasis?: boolean;
  comparisonPeriod?: boolean;
  [k: string]: unknown;
}

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
  ownerKind: PayrollReportOwnerKind;
  ownerRef: string | null;
  previewKind: PayrollReportPreviewKind;
  exportFormats: PayrollReportExportFormat[];
  parameters: PayrollReportParameters;
  metadata: Record<string, unknown>;
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

export const OWNER_LABEL: Record<PayrollReportOwnerKind, string> = {
  payroll_engine: "Payroll Engine",
  finance: "Cost & Finance",
  audit: "Audit",
  localization_pack: "Compliance",
  management: "Management",
  hr: "HR",
};

const OWNER_ORDER: PayrollReportOwnerKind[] = [
  "payroll_engine",
  "finance",
  "localization_pack",
  "management",
  "audit",
  "hr",
];

const DEFAULT_EXPORT_FORMATS: PayrollReportExportFormat[] = [
  { format: "pdf", label: "PDF", isPrimary: true },
  { format: "csv", label: "CSV" },
  { format: "xlsx", label: "Excel" },
];

export interface PayrollReportGroup {
  category: PayrollReportCategory;
  label: string;
  items: PayrollReportDefinition[];
}

export interface PayrollReportOwnerGroup {
  owner: PayrollReportOwnerKind;
  label: string;
  items: PayrollReportDefinition[];
}

function normalize(r: any): PayrollReportDefinition {
  const exportsRaw = Array.isArray(r.export_formats) ? r.export_formats : [];
  const exports: PayrollReportExportFormat[] = exportsRaw.length
    ? exportsRaw.map((f: any) => ({
        format: String(f.format),
        label: String(f.label ?? f.format),
        isPrimary: !!f.isPrimary,
      }))
    : DEFAULT_EXPORT_FORMATS;
  return {
    id: r.id,
    reportKey: r.report_key,
    label: r.label,
    description: r.description,
    category: r.category,
    scope: r.scope,
    countryCode: r.country_code,
    sortOrder: r.sort_order,
    featureFlag: r.feature_flag,
    ownerKind: (r.owner_kind as PayrollReportOwnerKind) ?? "payroll_engine",
    ownerRef: r.owner_ref ?? null,
    previewKind: (r.preview_kind as PayrollReportPreviewKind) ?? "table",
    exportFormats: exports,
    parameters: (r.parameters ?? {}) as PayrollReportParameters,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  };
}

export function usePayrollReportDefinitions(countryCode?: string | null) {
  return useQuery({
    queryKey: ["payroll-report-definitions", countryCode ?? null],
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<PayrollReportDefinition[]> => {
      const { data, error } = await (supabase as any)
        .from("payroll_report_definitions")
        .select(
          "id, report_key, label, description, category, scope, country_code, sort_order, feature_flag, owner_kind, owner_ref, preview_kind, export_formats, parameters, metadata",
        )
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      const rows = (data ?? []).filter(
        (r: any) => !r.country_code || !countryCode || r.country_code === countryCode,
      );
      return rows.map(normalize);
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

/**
 * Group definitions by owner rail (Payroll Engine, Cost & Finance,
 * Compliance:<country>, Management, Audit). This is the primary
 * rail for the Reporting Centre Library view because it makes report
 * ownership immediately legible and scales to 30+ countries publishing
 * their own statutory reports without producing a chip wall.
 */
export function groupPayrollReportsByOwner(
  defs: PayrollReportDefinition[] | undefined,
): PayrollReportOwnerGroup[] {
  if (!defs?.length) return [];
  const buckets = new Map<PayrollReportOwnerKind, PayrollReportDefinition[]>();
  for (const d of defs) {
    if (!buckets.has(d.ownerKind)) buckets.set(d.ownerKind, []);
    buckets.get(d.ownerKind)!.push(d);
  }
  return OWNER_ORDER.filter((o) => buckets.has(o)).map((o) => ({
    owner: o,
    label: OWNER_LABEL[o],
    items: buckets.get(o)!.sort((a, b) => a.sortOrder - b.sortOrder),
  }));
}
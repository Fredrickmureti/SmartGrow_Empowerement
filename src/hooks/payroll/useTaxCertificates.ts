import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface CertificateTemplate {
  id: string;
  pack_id: string | null;
  code: string;
  display_name: string;
  description: string | null;
  period: string;
  layout: string;
  body: any;
}

export interface TaxCertificate {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  employee_id: string;
  template_code: string;
  fiscal_year: number;
  payload: any;
  pdf_path: string | null;
  xlsx_path?: string | null;
  /**
   * Canonical per-certificate artifact list — one entry per pack-declared
   * output format. Empty for pre-migration rows (fall back to pdf_path /
   * xlsx_path). See ADR 0060 v2026.5.0 + migration 20260711232041.
   */
  artifacts?: Array<{
    format: string;
    path: string;
    mime?: string | null;
    ext?: string | null;
    size?: number | null;
    role?: string | null;
    generated_at?: string | null;
    label?: string | null;
  }>;
  serial_number: string;
  status: "draft" | "issued" | "superseded";
  generated_at: string;
  batch_id: string | null;
  stale?: boolean;
  stale_reason?: string | null;
  stale_at?: string | null;
  provenance?: any;
}

export interface TaxCertificateEvent {
  id: string;
  certificate_id: string;
  event_type:
    | "generated"
    | "superseded"
    | "downloaded"
    | "submitted"
    | "accepted"
    | "rejected"
    | "marked_stale"
    | "reissued";
  actor_user_id: string | null;
  details: any;
  created_at: string;
}

export interface CertificateSubmission {
  id: string;
  certificate_id: string;
  return_run_id: string | null;
  submitted_at: string;
  authority_reference: string | null;
  status: "submitted" | "accepted" | "rejected" | "retracted";
  rejection_reason: string | null;
}

export interface CertificateReconciliation {
  cert_count: number;
  cert_total_employee_tax: number;
  cert_total_employer_tax: number;
  return_count: number;
  return_total: number;
  remittance_total: number;
  variance_cert_vs_return: number;
  variance_return_vs_remittance: number;
}

export function useCertificateTemplates() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "certificate-templates", orgId, businessId],
    enabled: !!orgId && !!businessId,
    queryFn: async () => {
      // Canonical source of truth for which pack is active — eliminates
      // installed-vs-active status drift between this hook and the
      // generate-tax-certificate edge function (Step 3).
      const { data: installed } = await (supabase as any)
        .from("v_org_active_localization_pack")
        .select("pack_id")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .maybeSingle();
      const orFilter = installed?.pack_id
        ? `pack_id.eq.${installed.pack_id},pack_id.is.null`
        : "pack_id.is.null";
      const { data, error } = await (supabase as any)
        .from("localization_pack_certificate_templates")
        .select("id, pack_id, code, display_name, description, period, layout, body, sort_order")
        .or(orFilter)
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as CertificateTemplate[];
    },
  });
}

/**
 * Fiscal years that actually have payroll history for this org/business.
 * Drives the year picker so the UI doesn't hardcode CURRENT_YEAR-5 and
 * stays correct for non-Jan–Dec fiscal calendars (Step 4).
 */
export function useFiscalYearsForCertificates() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "fiscal-years", orgId, businessId],
    enabled: !!orgId && !!businessId,
    queryFn: async () => {
      const years = new Set<number>();
      const { data: periods } = await (supabase as any)
        .from("payroll_periods")
        .select("fiscal_year")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!);
      (periods ?? []).forEach((r: any) => {
        if (r.fiscal_year) years.add(Number(r.fiscal_year));
      });
      const { data: runs } = await (supabase as any)
        .from("payroll_runs")
        .select("pay_period_end")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!);
      (runs ?? []).forEach((r: any) => {
        if (r.pay_period_end) years.add(new Date(r.pay_period_end).getUTCFullYear());
      });
      const arr = Array.from(years).filter((y) => Number.isFinite(y)).sort((a, b) => b - a);
      // Always include current year so a fresh tenant can still issue something.
      const currentYear = new Date().getUTCFullYear();
      if (!arr.includes(currentYear)) arr.unshift(currentYear);
      return arr;
    },
  });
}

/** Lifecycle event ledger for one or more certificates. */
export function useCertificateEvents(certificateId: string | null | undefined) {
  return useQuery({
    queryKey: ["payroll", "tax-certificate-events", certificateId],
    enabled: !!certificateId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_tax_certificate_events")
        .select("*")
        .eq("certificate_id", certificateId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as TaxCertificateEvent[];
    },
  });
}

export function useTaxCertificates(params: { fiscalYear?: number; templateCode?: string }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "tax-certificates", orgId, businessId, params.fiscalYear, params.templateCode],
    enabled: !!orgId && !!businessId,
    queryFn: async () => {
      let q = (supabase as any)
        .from("payroll_tax_certificates")
        .select("*")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .order("generated_at", { ascending: false });
      if (params.fiscalYear) q = q.eq("fiscal_year", params.fiscalYear);
      if (params.templateCode) q = q.eq("template_code", params.templateCode);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as TaxCertificate[];
    },
  });
}

type GenerateTaxCertificateResult = {
  created: TaxCertificate[];
  skipped?: TaxCertificate[];
  errors: any[];
};

async function readFunctionErrorPayload(error: unknown): Promise<any | null> {
  const response = (error as any)?.context;
  if (!response || typeof response !== "object") return null;

  try {
    const readable = typeof response.clone === "function" ? response.clone() : response;
    const contentType = response.headers?.get?.("content-type") ?? "";
    if (contentType.includes("application/json") && typeof readable.json === "function") {
      return await readable.json();
    }
    if (typeof readable.text === "function") {
      const text = await readable.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return { message: text };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function taxCertificateGenerationError(error: unknown, payload: any) {
  const message = payload?.message ?? payload?.error;
  if (message) {
    const err: any = new Error(String(message));
    err.code = payload?.code;
    err.payload = payload;
    err.cause = error;
    return err;
  }
  return error;
}

export function useGenerateTaxCertificate() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      template_code: string;
      fiscal_year: number;
      employee_ids?: string[];
      branch_id?: string | null;
      regenerate?: boolean;
    }) => {
      const { data, error } = await supabase.functions.invoke("generate-tax-certificate", {
        body: {
          organization_id: currentOrg?.id,
          business_id: currentBusiness?.id,
          ...input,
        },
      });
      if (error) {
        const payload = await readFunctionErrorPayload(error);
        throw taxCertificateGenerationError(error, payload);
      }
      if ((data as any)?.error && !(data as any)?.created?.length) throw taxCertificateGenerationError(new Error((data as any).error), data);
      if (Array.isArray((data as any)?.errors) && (data as any).errors.length > 0 && !(data as any)?.created?.length) {
        const first = (data as any).errors[0];
        throw taxCertificateGenerationError(new Error(first?.error ?? "Tax certificate generation failed"), {
          error: first?.error ?? "Tax certificate generation failed",
          errors: (data as any).errors,
          skipped: (data as any).skipped ?? [],
        });
      }
      return data as GenerateTaxCertificateResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "tax-certificates"] });
    },
  });
}

/**
 * Localization health: installed pack + pending upgrade proposals (Step 5).
 */
export function useLocalizationHealth() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "localization-health", orgId, businessId],
    enabled: !!orgId && !!businessId,
    queryFn: async () => {
      const { data: active } = await (supabase as any)
        .from("v_org_active_localization_pack")
        .select("pack_id, pack_version, status")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .maybeSingle();
      let packName: string | null = null;
      let packCountry: string | null = null;
      let packLatestVersion: string | null = null;
      if (active?.pack_id) {
        const { data: pack } = await (supabase as any)
          .from("localization_packs")
          .select("name, country_code, version")
          .eq("id", active.pack_id)
          .maybeSingle();
        packName = pack?.name ?? null;
        packCountry = pack?.country_code ?? null;
        packLatestVersion = pack?.version ?? null;
      }
      const { data: proposals } = await (supabase as any)
        .from("pack_upgrade_proposals")
        .select("id, to_version, status")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .eq("status", "proposed");
      return {
        pack_id: active?.pack_id ?? null,
        pack_name: packName,
        pack_country: packCountry,
        installed_version: active?.pack_version ?? null,
        latest_version: packLatestVersion,
        status: active?.status ?? null,
        pending_upgrades: proposals?.length ?? 0,
      };
    },
  });
}

/**
 * Year readiness for certificate generation (Step 5).
 */
export function useYearReadiness(fiscalYear: number | null) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "year-readiness", orgId, businessId, fiscalYear],
    enabled: !!orgId && !!businessId && !!fiscalYear,
    queryFn: async () => {
      const { data: periods } = await (supabase as any)
        .from("payroll_periods")
        .select("id, status")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .eq("fiscal_year", fiscalYear!);
      const totalPeriods = periods?.length ?? 0;
      const closedPeriods = (periods ?? []).filter((p: any) =>
        ["closed", "committed", "locked", "posted"].includes(String(p.status).toLowerCase()),
      ).length;

      const yearStart = `${fiscalYear}-01-01`;
      const yearEnd = `${fiscalYear}-12-31`;
      const { data: runs } = await (supabase as any)
        .from("payroll_runs")
        .select("id, status, posted_at")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .gte("pay_period_end", yearStart)
        .lte("pay_period_end", yearEnd);
      const draftRuns = (runs ?? []).filter((r: any) =>
        !["committed", "posted", "approved", "locked"].includes(String(r.status).toLowerCase()),
      ).length;
      const committedRuns = (runs ?? []).filter((r: any) =>
        ["committed", "posted", "approved", "locked"].includes(String(r.status).toLowerCase()),
      ).length;
      const postedToGl = (runs ?? []).filter((r: any) => !!r.posted_at).length;

      const { data: findings } = await (supabase as any)
        .from("payroll_readiness_findings")
        .select("id, status")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .in("status", ["error", "blocking", "fail"]);
      const blockingFindings = findings?.length ?? 0;

      const { data: stale } = await (supabase as any)
        .from("payroll_tax_certificates")
        .select("id")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .eq("fiscal_year", fiscalYear!)
        .eq("stale", true);
      const staleCerts = stale?.length ?? 0;

      return {
        fiscalYear,
        totalPeriods,
        closedPeriods,
        draftRuns,
        committedRuns,
        postedToGl,
        blockingFindings,
        staleCerts,
        canIssue: blockingFindings === 0 && committedRuns > 0,
      };
    },
  });
}

/**
 * Employer reconciliation for FY × template (Step 7).
 */
export function useCertificateReconciliation(fiscalYear: number | null, templateCode: string | null) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "cert-reconciliation", orgId, businessId, fiscalYear, templateCode],
    enabled: !!orgId && !!businessId && !!fiscalYear && !!templateCode,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc("payroll_certificate_reconciliation", {
        p_organization_id: orgId,
        p_business_id: businessId,
        p_fiscal_year: fiscalYear,
        p_template_code: templateCode,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return (row ?? null) as CertificateReconciliation | null;
    },
  });
}

/**
 * Submission lifecycle rows for a set of certificates (Step 6).
 */
export function useCertificateSubmissions(certificateIds: string[]) {
  return useQuery({
    queryKey: ["payroll", "cert-submissions", certificateIds.sort().join(",")],
    enabled: certificateIds.length > 0,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_tax_certificate_submissions")
        .select("id, certificate_id, return_run_id, submitted_at, authority_reference, status, rejection_reason")
        .in("certificate_id", certificateIds);
      if (error) throw error;
      return (data ?? []) as CertificateSubmission[];
    },
  });
}

export async function downloadTaxCertificate(
  certificate:
    | Pick<TaxCertificate, "id" | "pdf_path"> | string
    | { artifact_path: string; filename?: string },
  format: "pdf" | "xlsx" = "pdf",
) {
  let body: Record<string, unknown>;
  if (typeof certificate === "string") {
    body = { pdf_path: certificate, format };
  } else if ("artifact_path" in certificate) {
    body = {
      artifact_path: certificate.artifact_path,
      filename: certificate.filename,
    };
  } else {
    body = { certificate_id: certificate.id, format };
  }
  const { data, error } = await supabase.functions.invoke("download-tax-certificate", { body });
  if (error || !(data as any)?.signedUrl) {
    const { toast } = await import("sonner");
    const message = (data as any)?.error ?? error?.message ?? "no signed URL";
    toast.error(`Could not download certificate: ${message}`);
    throw error ?? new Error(message);
  }
  const a = document.createElement("a");
  a.href = (data as any).signedUrl;
  a.rel = "noopener";
  a.target = "_blank";
  a.download = (data as any).filename ?? (format === "xlsx" ? "certificate.xlsx" : "certificate.pdf");
  document.body.appendChild(a);
  a.click();
  a.remove();
}

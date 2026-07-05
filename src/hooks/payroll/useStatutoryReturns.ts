import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

export interface ReturnTemplate {
  id: string;
  pack_id: string | null;
  code: string;
  display_name: string;
  description: string | null;
  authority_name: string | null;
  period: "monthly" | "quarterly" | "annual";
  /** Effective output: override wins over pack. */
  output: "csv" | "pdf" | "both";
  /** Effective body: override wins over pack. */
  body: any;
  /** Effective due_day: override wins over pack. */
  due_day: number | null;
  /** Effective due_month_offset: override wins over pack. */
  due_month_offset: number | null;
  /** Effective submission_channel (operational override or pack default). */
  submission_channel: string | null;
  /** Effective submission_format (operational override or pack default). */
  submission_format: any | null;
  /** Pack-owned legal metadata — never overridable. */
  authority_id: string | null;
  legal_reference: string | null;
  effective_date: string | null;
  sunset_date: string | null;
  approval_required: boolean;
  /** Pack template's updated_at; used by editor to seal staleness. */
  pack_updated_at: string | null;
  /** Slice-C discovery-time override surfacing. */
  is_overridden: boolean;
  override_version: number | null;
  /** True when override's snapshot of pack updated_at no longer matches. */
  override_stale: boolean;
  /** Which operational fields the tenant has overridden. */
  overridden_fields: Array<
    "body" | "submission_channel" | "submission_format" | "output" | "due_day" | "due_month_offset"
  >;
}

export interface ReturnRun {
  id: string;
  organization_id: string;
  business_id: string;
  branch_id: string | null;
  template_code: string;
  template_pack_id: string | null;
  period_start: string;
  period_end: string;
  payload: any;
  csv_path: string | null;
  pdf_path: string | null;
  gov_file_path: string | null;
  serial_number: string;
  status:
    | "draft"
    | "generated"
    | "pending_approval"
    | "submitted_awaiting_ack"
    | "acknowledged"
    | "rejected"
    | "filed"
    | "superseded";
  generated_at: string;
  filed_at: string | null;
  filed_reference: string | null;
  acknowledged_at: string | null;
  authority_ack_payload: any | null;
  submission_channel: string | null;
  portal_receipt_path: string | null;
  rejection_reasons: any | null;
  submitted_by: string | null;
  submitted_at: string | null;
  approver_id: string | null;
  approved_at: string | null;
  reconciliation_status: "unknown" | "ok" | "breach" | "overridden" | "not_applicable" | null;
  reconciliation_breach: any | null;
  reconciliation_override_reason: string | null;
}

export interface ReturnDiagnostic {
  id: string;
  run_id: string;
  code: string;
  severity: "info" | "warning" | "blocker";
  blocking: boolean;
  message: string;
  details: any | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string;
}

export interface FilingCalendarEntry {
  organization_id: string;
  business_id: string;
  template_code: string;
  display_name: string;
  period: "monthly" | "quarterly" | "annual";
  authority_name: string | null;
  period_start: string;
  period_end: string;
  due_date: string;
  latest_run_id: string | null;
  latest_run_status: string | null;
  state: "not_started" | "draft" | "generated" | "pending_approval" | "awaiting_ack" | "filed" | "rejected";
  is_overdue: boolean;
  is_overridden: boolean;
  override_stale: boolean;
  upgrade_pending: boolean;
  approval_required: boolean;
  reconciliation_status: string | null;
}


export function useReturnTemplates() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "return-templates", orgId, businessId],
    enabled: !!orgId && !!businessId,
    queryFn: async () => {
      const { data: installed } = await supabase
        .from("installed_localization_packs")
        .select("pack_id")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .in("status", ["installed", "active"])
        .maybeSingle();
      const orFilter = installed?.pack_id
        ? `pack_id.eq.${installed.pack_id},pack_id.is.null`
        : "pack_id.is.null";

      // Pack templates + (Slice-C) tenant overrides fetched in parallel.
      // Discovery merges them so the UI shows effective values and drift
      // flags up-front instead of at edge-function generation time (W3/W4).
      const [packsR, overridesR] = await Promise.all([
        (supabase as any)
          .from("localization_pack_return_templates")
          .select(
            "id, pack_id, code, display_name, description, authority_name, authority_id, " +
              "period, output, body, due_day, due_month_offset, sort_order, updated_at, " +
              "legal_reference, effective_date, sunset_date, submission_channel, submission_format, " +
              "approval_required",
          )
          .or(orFilter)
          .order("sort_order", { ascending: true }),
        (supabase as any)
          .from("payroll_return_template_overrides")
          .select(
            "template_code, body, submission_channel, submission_format, output, " +
              "due_day, due_month_offset, base_template_updated_at, override_version",
          )
          .eq("organization_id", orgId!)
          .eq("business_id", businessId!),
      ]);
      if (packsR.error) throw packsR.error;
      if (overridesR.error) throw overridesR.error;

      const overrideByCode = new Map<string, any>();
      for (const o of overridesR.data ?? []) overrideByCode.set(o.template_code, o);

      const merged: ReturnTemplate[] = (packsR.data ?? []).map((p: any) => {
        const ov = overrideByCode.get(p.code) ?? null;
        const overridden: ReturnTemplate["overridden_fields"] = [];
        const eff = {
          body: p.body,
          submission_channel: p.submission_channel ?? null,
          submission_format: p.submission_format ?? null,
          output: p.output,
          due_day: p.due_day,
          due_month_offset: p.due_month_offset,
        };
        if (ov) {
          if (ov.body != null) { eff.body = ov.body; overridden.push("body"); }
          if (ov.submission_channel != null) { eff.submission_channel = ov.submission_channel; overridden.push("submission_channel"); }
          if (ov.submission_format != null) { eff.submission_format = ov.submission_format; overridden.push("submission_format"); }
          if (ov.output != null) { eff.output = ov.output; overridden.push("output"); }
          if (ov.due_day != null) { eff.due_day = ov.due_day; overridden.push("due_day"); }
          if (ov.due_month_offset != null) { eff.due_month_offset = ov.due_month_offset; overridden.push("due_month_offset"); }
        }
        const stale = !!(
          ov?.base_template_updated_at &&
          p.updated_at &&
          new Date(ov.base_template_updated_at).getTime() !== new Date(p.updated_at).getTime()
        );
        return {
          id: p.id,
          pack_id: p.pack_id,
          code: p.code,
          display_name: p.display_name,
          description: p.description,
          authority_name: p.authority_name,
          authority_id: p.authority_id ?? null,
          period: p.period,
          output: eff.output,
          body: eff.body,
          due_day: eff.due_day,
          due_month_offset: eff.due_month_offset,
          submission_channel: eff.submission_channel,
          submission_format: eff.submission_format,
          legal_reference: p.legal_reference ?? null,
          effective_date: p.effective_date ?? null,
          sunset_date: p.sunset_date ?? null,
          approval_required: !!p.approval_required,
          pack_updated_at: p.updated_at ?? null,
          is_overridden: !!ov,
          override_version: ov?.override_version ?? null,
          override_stale: stale,
          overridden_fields: overridden,
        };
      });
      return merged;
    },
  });
}

/**
 * Cheap probe used by empty-state UIs to differentiate
 * "no pack installed for this business" from
 * "pack installed but no return templates published".
 */
export function useHasInstalledLocalizationPack() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "has-installed-pack", orgId, businessId],
    enabled: !!orgId && !!businessId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("installed_localization_packs")
        .select("pack_id")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .in("status", ["installed", "active"])
        .maybeSingle();
      if (error) throw error;
      return !!data?.pack_id;
    },
  });
}

export function useReturnRuns(params: { templateCode?: string; year?: number }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "return-runs", orgId, businessId, params.templateCode, params.year],
    enabled: !!orgId && !!businessId,
    queryFn: async () => {
      let q = (supabase as any)
        .from("payroll_return_runs")
        .select("*")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .order("period_end", { ascending: false })
        .order("generated_at", { ascending: false });
      if (params.templateCode) q = q.eq("template_code", params.templateCode);
      if (params.year) {
        const start = `${params.year}-01-01`;
        const end = `${params.year}-12-31`;
        q = q.gte("period_start", start).lte("period_end", end);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as ReturnRun[];
    },
  });
}

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

function statutoryReturnGenerationError(error: unknown, payload: any) {
  if (payload?.expected && payload?.message) {
    return {
      kind: "validation" as const,
      title: "Return not ready",
      message: String(payload.message),
      action: payload.action ? String(payload.action) : "Review the payroll period and try again.",
      retryable: false,
      cause: error,
    };
  }

  if (payload?.message) {
    return {
      kind: "unknown" as const,
      title: "Return generation failed",
      message: String(payload.message),
      action: "Review the return setup and try again.",
      retryable: true,
      cause: error,
    };
  }

  return error;
}

export function useGenerateStatutoryReturn() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      template_code: string;
      period_start: string;
      period_end: string;
      branch_id?: string | null;
      regenerate?: boolean;
    }) => {
      const { data, error } = await supabase.functions.invoke("generate-statutory-return", {
        body: {
          organization_id: currentOrg?.id,
          business_id: currentBusiness?.id,
          ...input,
        },
      });
      if (error) {
        const payload = await readFunctionErrorPayload(error);
        throw statutoryReturnGenerationError(error, payload);
      }
      if ((data as any)?.error && !(data as any)?.run) throw statutoryReturnGenerationError(new Error((data as any).error), data);
      return data as { run: ReturnRun; reconciliation: any; totals: Record<string, number> };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "return-runs"] });
    },
  });
}

/**
 * Record the authority's response to a filed/submitted return.
 * Structured — caller passes typed fields including submission_channel
 * (iTax / eCitizen / URA / etc.), portal receipt path, and rejection reasons.
 * Writes a `payroll_return_filing_events` audit row alongside the state change.
 */
export function useRecordReturnAcknowledgement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      run_id: string;
      organization_id: string;
      business_id: string;
      outcome: "pending_approval" | "submitted_awaiting_ack" | "acknowledged" | "rejected" | "filed";
      filed_reference?: string | null;
      acknowledged_at?: string | null;
      submission_channel?: "itax" | "ecitizen" | "ura" | "tra" | "sars" | "elstam" | "manual" | "api" | "other" | null;
      portal_receipt_path?: string | null;
      rejection_reasons?: Array<{ code?: string; message: string; field?: string }> | null;
      ack: {
        receipt_number?: string;
        receipt_date?: string;
        authority_status?: string;
        notes?: string;
      };
    }) => {
      // All state transitions, audit-row writes, and receipt-path stamping
      // happen server-side in `record-return-filing` (W1). The edge function
      // validates the transition via `payroll_return_assert_transition` and
      // refuses illegal jumps with HTTP 409.
      const { data, error } = await supabase.functions.invoke("record-return-filing", {
        body: {
          run_id: input.run_id,
          to_status: input.outcome,
          filed_reference: input.filed_reference ?? null,
          submission_channel: input.submission_channel ?? null,
          rejection_reasons: input.rejection_reasons ?? null,
          ack: input.ack,
          // Receipt-file upload is supported separately via uploadPortalReceipt
          // when the user has only the storage path; the edge function also
          // accepts base64 directly if needed.
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return (data as any).run as ReturnRun;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "return-runs"] });
      qc.invalidateQueries({ queryKey: ["payroll", "filing-calendar"] });
    },
  });
}

/**
 * Filing calendar — every statutory return owed by the org for the most
 * recently closed period, with computed due date and overdue flag.
 * Powered by the `payroll_filing_calendar` DB view (security_invoker).
 */
export function useFilingCalendar() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  return useQuery({
    queryKey: ["payroll", "filing-calendar", orgId, businessId],
    enabled: !!orgId && !!businessId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_filing_calendar")
        .select("*")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .order("due_date", { ascending: true });
      if (error) throw error;
      return (data ?? []) as FilingCalendarEntry[];
    },
  });
}

export async function downloadReturnArtifact(path: string) {
  const { data, error } = await supabase.storage.from("documents").createSignedUrl(path, 60);
  if (error) throw error;
  window.open(data.signedUrl, "_blank");
}

/**
 * Upload an authority's stamped acknowledgement receipt (PDF/image) to
 * the `documents` bucket and return its storage path. Caller passes the
 * path to `useRecordReturnAcknowledgement` as `portal_receipt_path`.
 */
export async function uploadPortalReceipt(opts: {
  organizationId: string;
  runId: string;
  file: File;
}): Promise<string> {
  const ext = opts.file.name.split(".").pop() ?? "pdf";
  const path = `${opts.organizationId}/payroll/return-receipts/${opts.runId}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage
    .from("documents")
    .upload(path, opts.file, { contentType: opts.file.type, upsert: true });
  if (error) throw error;
  return path;
}
/**
 * Blocking & informational diagnostics attached to a return run (Slice D).
 * The DB submission gate refuses `submitted_*` while any unresolved blocker
 * exists. Tenants resolve via `useOverrideReturnDiagnostic` with a reason.
 */
export function useReturnDiagnostics(runId: string | null | undefined) {
  return useQuery({
    queryKey: ["payroll", "return-diagnostics", runId],
    enabled: !!runId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("payroll_return_diagnostics")
        .select("*")
        .eq("run_id", runId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ReturnDiagnostic[];
    },
  });
}

export function useOverrideReturnDiagnostic() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { diagnostic_id: string; run_id: string; reason: string }) => {
      const { data, error } = await supabase.functions.invoke("override-return-diagnostic", {
        body: { diagnostic_id: input.diagnostic_id, reason: input.reason },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["payroll", "return-diagnostics", vars.run_id] });
      qc.invalidateQueries({ queryKey: ["payroll", "return-runs"] });
    },
  });
}

/**
 * Dispatch a generated return to the statutory authority via the metadata
 * driven e-filing dispatcher (Slice G — submit-statutory-return). The
 * function reads the template's api_endpoint_spec / digital_signature_spec /
 * acknowledgement_spec — no per-country code path runs in the browser.
 */
export function useDispatchStatutoryReturn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { run_id: string }) => {
      const { data, error } = await supabase.functions.invoke("submit-statutory-return", {
        body: { run_id: input.run_id },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as {
        ok: true;
        http_status: number;
        authority_reference: string | null;
        to_status: "submitted_awaiting_ack" | "acknowledged";
      };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payroll", "return-runs"] });
      qc.invalidateQueries({ queryKey: ["payroll", "filing-calendar"] });
    },
  });
}

/**
 * Returns the count of `payroll_runs` whose pay-period window intersects
 * `[periodStart, periodEnd]` for the active org/business. Used by the
 * Returns UI to disable Generate when there's nothing to aggregate —
 * the edge function would otherwise fail late with a reconciliation
 * error the user can't act on.
 */
export function usePayrollRunsInPeriod(args: { periodStart?: string; periodEnd?: string }) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const { periodStart, periodEnd } = args;
  return useQuery({
    queryKey: ["payroll", "runs-in-period", orgId, businessId, periodStart, periodEnd],
    enabled: !!orgId && !!businessId && !!periodStart && !!periodEnd,
    queryFn: async () => {
      const { count, error } = await (supabase as any)
        .from("payroll_runs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .lte("pay_period_start", periodEnd!)
        .gte("pay_period_end", periodStart!);
      if (error) throw error;
      return count ?? 0;
    },
  });
}

/**
 * Return-generation eligibility preflight — mirrors the two gates the
 * `generate-statutory-return` edge function applies:
 *   1. at least one payroll_run in the period with approved_at IS NOT NULL
 *   2. at least one payslip on those runs whose status matches the template's
 *      body.filters.payslip_status (empty filter ⇒ any status counts)
 *
 * Surfacing this in the UI converts the edge function's structured 400
 * (NO_APPROVED_PAYROLL_RUNS / NO_ELIGIBLE_PAYSLIPS) into a pre-click
 * readiness state — mirroring how Workday's Tax Filing dashboard and
 * SAP's PC00_M99_URMR report show remittance readiness before submission.
 */
export type ReturnEligibility = {
  ready: boolean;
  blocking_reason: "ready" | "no_approved_run" | "no_eligible_payslips";
  approved_runs_count: number;
  eligible_payslips_count: number;
  total_payslips_count: number;
  required_statuses: string[];
  status_breakdown: Record<string, number>;
};

export function useReturnEligibility(args: {
  template?: ReturnTemplate | null;
  periodStart?: string;
  periodEnd?: string;
  branchId?: string | null;
}) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const businessId = currentBusiness?.id;
  const { template, periodStart, periodEnd, branchId } = args;

  const requiredStatuses: string[] = Array.isArray(template?.body?.filters?.payslip_status)
    ? (template!.body.filters.payslip_status as any[]).map((s) => String(s))
    : [];

  return useQuery<ReturnEligibility>({
    queryKey: [
      "payroll",
      "return-eligibility",
      orgId,
      businessId,
      template?.code,
      periodStart,
      periodEnd,
      branchId ?? null,
      requiredStatuses.join(","),
    ],
    enabled: !!orgId && !!businessId && !!template && !!periodStart && !!periodEnd,
    queryFn: async () => {
      const { data: runs, error: runsErr } = await (supabase as any)
        .from("payroll_runs")
        .select("id")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .lte("pay_period_start", periodEnd!)
        .gte("pay_period_end", periodStart!)
        .not("approved_at", "is", null);
      if (runsErr) throw runsErr;
      const runIds: string[] = (runs ?? []).map((r: any) => r.id);
      if (runIds.length === 0) {
        return {
          ready: false,
          blocking_reason: "no_approved_run",
          approved_runs_count: 0,
          eligible_payslips_count: 0,
          total_payslips_count: 0,
          required_statuses: requiredStatuses,
          status_breakdown: {},
        };
      }

      let q = (supabase as any)
        .from("payslips")
        .select("status")
        .eq("organization_id", orgId!)
        .eq("business_id", businessId!)
        .in("payroll_run_id", runIds);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data: slips, error: slipsErr } = await q;
      if (slipsErr) throw slipsErr;

      const breakdown: Record<string, number> = {};
      for (const s of slips ?? []) {
        const key = String((s as any).status ?? "unknown");
        breakdown[key] = (breakdown[key] ?? 0) + 1;
      }
      const total = (slips ?? []).length;
      const eligible = requiredStatuses.length
        ? requiredStatuses.reduce((n, st) => n + (breakdown[st] ?? 0), 0)
        : total;

      return {
        ready: eligible > 0,
        blocking_reason: eligible > 0 ? "ready" : "no_eligible_payslips",
        approved_runs_count: runIds.length,
        eligible_payslips_count: eligible,
        total_payslips_count: total,
        required_statuses: requiredStatuses,
        status_breakdown: breakdown,
      };
    },
  });
}

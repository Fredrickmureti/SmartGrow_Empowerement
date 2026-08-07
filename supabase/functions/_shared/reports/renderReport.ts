/**
 * Shared report-render funnel.
 *
 * Centralizes the steps every PDF endpoint repeats:
 *   1. entitlement check (caller's responsibility — gated upstream)
 *   2. organization branding lookup
 *   3. column-spec resolution (registry → caller-provided → inference)
 *   4. format profile (financial vs operational) from registry
 *   5. PDF byte rendering
 *   6. audit trail insert (`report_run_log`) — non-blocking
 *
 * Used by:
 *   - render-report  (the canonical entry point)
 *   - generate-report-pdf (legacy entry kept for the live UI)
 *   - process-scheduled-reports (cron path)
 */

import {
  generateReportPdf,
  type ReportPdfPayload,
  type ReportColumn,
  type ReportRow,
} from "../reportPdfGenerator.ts";
import { getOrganizationBranding, type OrganizationBranding } from "../branding/index.ts";
import { getReportSpec, getReportTitle } from "./columnSpecs.ts";
import { resolveReportColumns } from "./resolveColumns.ts";
import { resolvePrintPolicy, type PaperFormat } from "../printing/resolvePolicy.ts";
import {
  inferPresentationProfile,
  type PresentationProfile,
} from "../pdf/index.ts";

export interface RenderReportOptions {
  /** If supplied, branding is loaded once via this organizationId. */
  organizationId?: string;
  /** Optional: which sub-business (location / branch) the run belongs to. */
  businessId?: string;
  /** Optional pre-loaded branding (skips DB hit). */
  organization?: OrganizationBranding;
  /** Report-type key from the registry. Drives column lookup + default title. */
  reportType?: string;
  /** Caller-provided columns. Wins over the registry. */
  columns?: ReportColumn[];
  /** Optional explicit title (otherwise registry default). */
  title?: string;
  /** Optional date range string for the masthead ("For the period …"). */
  dateRange?: string;
  /**
   * Point-in-time reports (Trial Balance, Balance Sheet): the masthead
   * renders "As of <asOf>" instead of "For the period <dateRange>".
   */
  asOf?: string;
  /** Page orientation override. */
  orientation?: "portrait" | "landscape";

  /** Body rows. */
  rows: ReportRow[];
  /** Currency code for accountant-grade number formatting. */
  currency?: string;
  /** Pass-through for statements / payroll-style payloads. */
  recipientInfo?: ReportPdfPayload["recipientInfo"];
  amountDue?: string;
  summaryRows?: ReportPdfPayload["summaryRows"];
  footerNote?: string;
  /**
   * Stage 3: override the registry default. Most callers should leave
   * this unset and let the registry decide.
   */
  formatProfile?: "financial" | "operational";
  /** Stage 3: explicit subtitle (overrides registry default). */
  subtitle?: string;
  /**
   * Presentation profile override (typography + density only). Callers
   * should normally leave this unset — the registry decides.
   */
  presentationProfile?: PresentationProfile;
  /**
   * Stage 4: who triggered the run. Used in the standard disclosure
   * footer line and persisted to `report_run_log`. Pass null/undefined
   * for system-driven runs (cron, automations).
   */
  userId?: string | null;
  userName?: string | null;
  /**
   * Optional: arbitrary call parameters to persist with the audit row.
   * Helpful for "rerun this exact report" debugging.
   */
  params?: Record<string, unknown>;
  /**
   * Stage W5 (ADR-0008): explicit paper override. Wins over the resolved
   * `document_print_policies` row. Reports never accept ESC/POS — render
   * mode is clamped to PDF (raw thermal bytes don't make sense for a
   * paginated financial report viewed in a browser/email).
   */
  paperFormat?: PaperFormat;
  /** Branch context for the policy resolver. */
  branchId?: string | null;
}

/**
 * Derive the canonical reporting-scope line.
 *
 * This is the single owner of that string. Report modules and UI pages must
 * never hand-compose a scope label, otherwise the same run reads "Nairobi"
 * on screen and "Headquarters (HQ)" on paper.
 *
 * The masthead already states the legal entity, so the scope line does NOT
 * repeat it when it is the same name:
 *   - branch selected → "Nairobi Branch" (HQ flagged as "… (HQ)")
 *   - no branch, business known → "All branches"
 *   - business differs from the masthead name → "<Business> · <Branch>"
 *   - no identity at all → undefined (masthead omits the line)
 */
async function resolveReportScope(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  input: {
    mastheadName?: string | null;
    businessName?: string | null;
    businessId?: string | null;
    branchId?: string | null;
  },
): Promise<string | undefined> {
  const business = input.businessName?.trim() || null;
  const masthead = input.mastheadName?.trim() || null;
  let branch: string | null = null;

  if (input.branchId) {
    try {
      const { data } = await supabase
        .from("branches")
        .select("name, is_headquarters")
        .eq("id", input.branchId)
        .maybeSingle();
      if (data?.name) {
        branch = data.is_headquarters ? `${data.name} (HQ)` : data.name;
      }
    } catch (e) {
      console.warn("[renderReport] branch scope lookup failed:", (e as Error).message);
    }
  } else if (business || input.businessId) {
    branch = "All branches";
  }

  const label = business && business !== masthead ? business : null;
  const parts = [label, branch].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : undefined;
}


/**
 * Resolve columns + title + orientation + format-profile from the registry,
 * render the PDF, and write a (best-effort) audit row.
 */

export async function renderReport(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  options: RenderReportOptions,
): Promise<Uint8Array> {
  const spec = options.reportType ? getReportSpec(options.reportType) : null;

  const columns = resolveReportColumns({
    reportType: options.reportType ?? null,
    explicit: options.columns ?? null,
    rows: options.rows,
  });

  const title =
    options.title ??
    (options.reportType ? getReportTitle(options.reportType) : "Report");
  const orientation = options.orientation ?? spec?.orientation ?? "landscape";
  const formatProfile = options.formatProfile ?? spec?.formatProfile ?? "operational";
  const subtitle = options.subtitle ?? spec?.subtitle;

  // Presentation profile: explicit override > registry pin > derivation
  // from the format profile and the report's horizontal pressure. This is
  // the ONLY place a report's typography is decided — individual report
  // modules never pass sizes.
  const presentationProfile: PresentationProfile =
    options.presentationProfile ??
    spec?.presentationProfile ??
    inferPresentationProfile(formatProfile, columns.length);

  // ── Stage W5 (ADR-0008): resolve report paper policy ─────────────
  // Reports get their own policy namespace `report:<reportType>` so
  // they don't collide with transactional document policies. Render
  // mode is forced to "pdf" — see hook docstring above for why.
  let resolvedPaper: PaperFormat = options.paperFormat ?? "a4";
  if (!options.paperFormat && options.organizationId && options.reportType) {
    try {
      const policy = await resolvePrintPolicy(supabase, {
        businessId: options.businessId ?? null,
        branchId: options.branchId ?? null,
        documentType: `report:${options.reportType}`,
      });
      // Reports never go thermal — fall back to A4 if a misconfigured
      // policy somehow ended up with 80mm/58mm.
      resolvedPaper =
        policy.paper_format === "80mm" || policy.paper_format === "58mm"
          ? "a4"
          : (policy.paper_format as PaperFormat);
    } catch (e) {
      console.warn("[renderReport] policy resolve failed, defaulting to A4:", (e as Error).message);
    }
  }

  // Branding: caller > DB lookup. The lookup MUST carry the business and
  // branch the report was run for — in a multi-entity tenant the masthead
  // legal name and logo belong to the reporting entity, not to whichever
  // business happens to be the organization's first.
  let organization = options.organization;
  if (!organization && (options.organizationId || options.businessId)) {
    organization =
      (await getOrganizationBranding(
        supabase,
        options.organizationId ?? "",
        options.businessId ?? null,
        options.branchId ?? null,
      )) ?? undefined;
  }

  // Reporting scope line ("<Business> · <Branch>") — derived ONCE here so
  // every report states its scope identically. Callers never compose it.
  const scope = await resolveReportScope(supabase, {
    mastheadName: organization?.name,
    businessName: organization?.name,
    businessId: options.businessId,
    branchId: options.branchId,
  });


  // Currency default: caller > org base_currency
  const currency = options.currency ?? organization?.base_currency ?? undefined;


  // Stage 4: compute a short run-hash (sha1 prefix) over the call shape so
  // the printed footer can be tied back to the exact run row.
  const runHash = await computeRunHash({
    reportType: options.reportType,
    organizationId: options.organizationId,
    businessId: options.businessId,
    title,
    dateRange: options.dateRange,
    rowCount: options.rows.length,
    userId: options.userId ?? null,
    ts: Date.now(),
  });

  const pdfBytes = await generateReportPdf({
    title,
    subtitle,
    dateRange: options.dateRange,
    asOf: options.asOf,
    scope,

    columns,
    rows: options.rows,
    orientation,
    organization,
    currency,
    recipientInfo: options.recipientInfo,
    amountDue: options.amountDue,
    summaryRows: options.summaryRows,
    footerNote: options.footerNote,
    formatProfile,
    presentationProfile,
    paperFormat: resolvedPaper as any,
    disclosure: {
      user: options.userName ?? null,
      org: organization?.name ?? null,
      runHash,
    },
  });

  // Stage 5: best-effort audit write. Never blocks PDF delivery.
  // If the table doesn't exist yet (older deployments) the catch swallows it.
  try {
    await supabase.from("report_run_log").insert({
      organization_id: options.organizationId ?? null,
      business_id: options.businessId ?? null,
      user_id: options.userId ?? null,
      report_type: options.reportType ?? "ad_hoc",
      params_jsonb: options.params ?? null,
      run_hash: runHash,
      byte_count: pdfBytes.length,
      status: "ok",
    });
  } catch (e) {
    console.warn("[renderReport] audit write skipped:", (e as Error).message);
  }

  return pdfBytes;
}

/**
 * 8-char SHA-1 prefix of a stable JSON serialization. Intentionally short —
 * collisions are acceptable because the full provenance lives in
 * `report_run_log`. The footer hash is just a human-friendly handle.
 */
async function computeRunHash(input: Record<string, unknown>): Promise<string> {
  try {
    const json = JSON.stringify(input);
    const buf = new TextEncoder().encode(json);
    const digest = await crypto.subtle.digest("SHA-1", buf);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return hex.slice(0, 8);
  } catch {
    return Math.random().toString(16).slice(2, 10);
  }
}

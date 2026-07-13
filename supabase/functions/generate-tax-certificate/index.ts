/**
 * generate-tax-certificate (R6)
 *
 * Country-agnostic tax certificate generator. Resolves a declarative template
 * from `localization_pack_certificate_templates` (template's `pack_id` matches
 * the org's installed pack, or NULL = generic fallback), reads YTD totals from
 * `payroll_employee_ytd_rollup`, snapshots the resolved payload, renders a PDF
 * via the shared report PDF generator, uploads to the `documents` bucket, and
 * inserts a `payroll_tax_certificates` row. Bulk per call. `regenerate=true`
 * supersedes the prior issued row (both retained for audit).
 *
 * No country code branches. Layout differences come from `template.layout`.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { generateReportPdf, type ReportPdfPayload } from "../_shared/reportPdfGenerator.ts";
import { assertStatutoryPaper } from "../_shared/pdf/index.ts";
import { compile as compileCertificateHtml } from "../_shared/certificate-engine/compile.ts";
import { buildMatrixRows, collectMatrixRuleCodes, sumMatrixColumn } from "../_shared/certificateMatrix.ts";
import { type CertificateTemplateV3 } from "../_shared/certificate-engine/types.ts";
import { getOrganizationBranding } from "../_shared/branding/index.ts";
import { renderTemplateBody, toSummaryRows } from "../_shared/renderTemplateBody.ts";
import { type MonthlyRow } from "../_shared/certificateSections.ts";
import { resolveCertificateYtd } from "../_shared/certificateSourceResolver.ts";
import {
  requireApprovedRunsForYear,
} from "../_shared/payrollLifecycleGate.ts";
import { buildProjectedEmployeeMap } from "../_shared/employeeStatutoryProjection.ts";

// Canonical artifact shape aligned with `payroll_tax_certificates.artifacts`
// and `payroll_return_runs.artifacts` (see migration 20260711232041 +
// tax-certificates follow-up). Every dispatched output produces one of these.
interface CertificateArtifact {
  format: string;
  path: string;
  mime: string;
  ext: string;
  size: number;
  role: string;
  generated_at: string;
  label?: string | null;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface RequestBody {
  organization_id: string;
  business_id: string;
  template_code: string;
  fiscal_year: number;
  employee_ids?: string[];
  branch_id?: string | null;
  regenerate?: boolean;
}

interface RollupRow {
  rule_code: string;
  category: string | null;
  employee_amount: number;
  employer_amount: number;
  taxable_amount: number;
}

const STORAGE_BUCKET = "documents";
const CERTIFICATE_RENDERER_VERSION = "certificate-engine-v3-html-2026-07-12.1";

async function sha256Hex(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value ?? null));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Certificate templates are v3-only since the pdf-lib renderers were retired
// (DB validator `assert_certificate_template_body_valid` enforces
// schema_version >= 3). These helpers remain as thin readability aids.
function isV3EngineTemplate(template: any): boolean {
  return Number(template?.body?.schema_version ?? 1) >= 3
    && Array.isArray(template?.body?.document);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Structured business-error envelope, mirrored on `generate-statutory-return`.
 * The client uses `code` to render an actionable message + recovery hint
 * instead of showing "500 Internal Server Error". Every predictable refusal
 * from this edge function should go through here.
 */
function businessError(
  status: number,
  code: string,
  message: string,
  recovery: string,
  context: Record<string, unknown> = {},
) {
  return jsonResponse(
    { error: code, code, message, recovery, ...context },
    status,
  );
}

function fmtMoney(n: number, currency = "") {
  const s = (Number(n) || 0).toFixed(2);
  return currency ? `${currency} ${s}` : s;
}

function makeSerial(orgId: string, employeeId: string, fiscalYear: number, code: string) {
  const stamp = Date.now().toString(36).toUpperCase();
  const suffix = employeeId.slice(0, 8).toUpperCase();
  return `${code}-${fiscalYear}-${suffix}-${stamp}`;
}

function normalizeTemplatePage(body: any) {
  const page = body?.page ?? {};
  const orientation = String(page.orientation ?? "portrait").toLowerCase() === "landscape"
    ? "landscape"
    : "portrait";
  return { size: "a4", orientation };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) return jsonResponse({ error: "unauthenticated" }, 401);
    const userId = userData.user.id;

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id || !body.business_id || !body.template_code || !body.fiscal_year) {
      return jsonResponse({ error: "missing required fields" }, 400);
    }
    const employeeIds = Array.isArray(body.employee_ids) ? body.employee_ids.filter(Boolean) : [];
    if (!employeeIds.length && !body.branch_id) {
      return jsonResponse({ error: "employee_ids or branch_id required" }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Permission: issuing a statutory employer document is a payroll act,
    // not an accounting act. Gate on payroll.write to align with the
    // payroll_tax_certificates RLS policy (tax_cert_managers_write).
    const { data: perm, error: permErr } = await admin.rpc("user_has_module_permission", {
      _user_id: userId,
      _org_id: body.organization_id,
      _business_id: body.business_id,
      _module: "payroll",
      _operation: "write",
    });
    if (permErr) return jsonResponse({ error: `permission check failed: ${permErr.message}` }, 500);
    if (!perm) return jsonResponse({ error: "permission denied" }, 403);

    // Resolve template via the canonical view so client + server agree
    // on which pack is "active" for this org/business (eliminates the
    // installed-vs-active status drift between hook and edge function).
    const { data: orgSetting } = await admin
      .from("v_org_active_localization_pack")
      .select("pack_id")
      .eq("organization_id", body.organization_id)
      .eq("business_id", body.business_id)
      .maybeSingle();

    // Resolve pack template (pack-specific or generic)
    let packTemplate: any = null;
    if (orgSetting?.pack_id) {
      const r = await admin
        .from("localization_pack_certificate_templates")
        .select("*")
        .eq("pack_id", orgSetting.pack_id)
        .eq("code", body.template_code)
        .maybeSingle();
      packTemplate = r.data;
    }
    if (!packTemplate) {
      const r = await admin
        .from("localization_pack_certificate_templates")
        .select("*")
        .is("pack_id", null)
        .eq("code", body.template_code)
        .maybeSingle();
      packTemplate = r.data;
    }
    if (!packTemplate) {
      return businessError(
        404,
        "TEMPLATE_NOT_INSTALLED",
        `No tax certificate template "${body.template_code}" is available for this business. Install the localization pack that ships this template, or add a tenant override, before generating the certificate.`,
        "Open Settings → Localization → Packs, install the country pack that provides this certificate (or create an override in Payroll → Compliance → Certificate templates), then retry generation.",
        {
          template_code: body.template_code,
          pack_id: orgSetting?.pack_id ?? null,
          requires: "localization_pack_certificate_templates",
        },
      );
    }

    // Override coalesce: tenant override wins; staleness blocks generation.
    const { data: override } = await admin
      .from("payroll_certificate_template_overrides")
      .select("*")
      .eq("business_id", body.business_id)
      .eq("template_code", body.template_code)
      .maybeSingle();

    let template: any = packTemplate;
    let templateSource: "pack" | "override" = "pack";
    let overrideVersion: number | null = null;
    if (override) {
      if (
        override.base_template_updated_at &&
        new Date(override.base_template_updated_at).getTime() !==
          new Date(packTemplate.updated_at).getTime()
      ) {
        return jsonResponse(
          {
            error: "TEMPLATE_OUT_OF_DATE",
            message:
              "Pack template has changed since this override was last saved. Re-acknowledge the override before regenerating.",
            template_code: body.template_code,
          },
          409,
        );
      }
      template = {
        ...packTemplate,
        body: override.body,
        layout: override.layout ?? packTemplate.layout,
      };
      templateSource = "override";
      overrideVersion = override.override_version;
    }

    const templateBodyHash = await sha256Hex(template.body ?? {});

    // ADR 0060 v2026.4.0 — Structural refusal. V2 block templates are
    // authoritative when present; legacy sections[] is validated only for
    // pre-v2 templates so stale compatibility sections cannot keep driving
    // a migrated pack's runtime behavior.
    {
      const isV3 = isV3EngineTemplate(template);
      const isV2 = !isV3 && isV2BlockTemplate(template);
      // v3 templates express their contract as a `document` node tree
      // (heading / identity_strip / matrix / signature_strip / …); v2 uses
      // `blocks`; pre-v2 uses `sections`. Validate the shape appropriate to
      // the template's own schema_version so a migrated template isn't
      // judged against a contract it no longer uses.
      const nodes = isV3
        ? (Array.isArray(template?.body?.document) ? template.body.document : [])
        : isV2
          ? (template.body.blocks ?? [])
          : (Array.isArray(template?.body?.sections) ? template.body.sections : []);
      const types = new Set<string>(nodes.map((s: any) => String(s?.type ?? "")));
      const missing: string[] = [];
      let hasData: boolean;
      if (isV3) {
        // The only hard requirement is a data-bearing node (a matrix or
        // table). Identity/signature nodes are strongly recommended but the
        // compiler renders gracefully without them, so they are not fatal.
        hasData = types.has("matrix") || types.has("table");
        if (!hasData) missing.push("matrix");
      } else if (isV2) {
        const hasEmployer = nodes.some((b: any) => b?.type === "field_grid" && String(b?.data_source ?? "") === "employer");
        const hasEmployee = nodes.some((b: any) => b?.type === "field_grid" && String(b?.data_source ?? "") === "employee");
        if (!hasEmployer) missing.push("employer field_grid");
        if (!hasEmployee) missing.push("employee field_grid");
        if (!types.has("signature_block")) missing.push("signature_block");
        hasData = nodes.some((b: any) => b?.type === "table" && ["monthly_breakdown", "monthly_matrix", "ytd_rows"].includes(String(b?.data_source ?? "")));
      } else {
        for (const need of ["employer_header", "employee_header", "signature_block"]) {
          if (!types.has(need)) missing.push(need);
        }
        hasData = ["monthly_breakdown", "ytd_table", "totals"].some((d) => types.has(d));
      }
      const contract = isV3 ? "document" : isV2 ? "blocks" : "sections";
      if (nodes.length === 0 || missing.length > 0 || !hasData) {
        // Best-effort diagnostic so the Publisher Health panel can surface
        // packs whose templates are being refused in the field.
        try {
          await admin.from("payroll_diagnostics").insert({
            organization_id: body.organization_id,
            business_id: body.business_id,
            severity: "error",
            code: "TEMPLATE_STRUCTURAL_INVALID",
            message: `Certificate template "${template.code}" refused: missing section contract`,
            details: {
              template_code: template.code,
              template_source: templateSource,
              pack_id: template.pack_id ?? null,
              contract,
              sections_present: Array.from(types),
              missing_identity_sections: missing,
              has_data_section: hasData,
            },
          });
        } catch { /* diagnostics best-effort */ }
        return businessError(
          422,
          "TEMPLATE_STRUCTURAL_INVALID",
          `Certificate template "${template.code}" cannot be rendered: its body is missing the required section contract (identity headers, data section, and signature block). This template ships as a legacy stub and must be refreshed at the pack level before it can be issued.`,
          "Ask your platform administrator to publish the latest localization pack version that ships this certificate with a full section layout.",
          {
            template_code: template.code,
            template_source: templateSource,
            contract,
            sections_present: Array.from(types),
            missing_identity_sections: missing,
            has_data_section: hasData,
          },
        );
      }
    }

    // Resolve employees
    // Wave 1.1: position/department resolved via FK joins (legacy text cols dropped)
    // Statutory identifiers (tax_pin, nssf_number, …) live in
    // employee_statutory_identifiers keyed by identifier_type — do NOT
    // reference dropped columns like tax_pin on employees directly.
    let employeesQuery = admin
      .from("employees")
      .select("id, first_name, last_name, employee_number, national_id, email, branch_id, business_id, organization_id, department:departments!employees_department_id_fkey(name), job_position:job_positions(name)")
      .eq("organization_id", body.organization_id)
      .eq("business_id", body.business_id);
    if (employeeIds.length) {
      employeesQuery = employeesQuery.in("id", employeeIds);
    } else if (body.branch_id) {
      employeesQuery = employeesQuery.eq("branch_id", body.branch_id).eq("is_active", true);
    }
    const { data: employees, error: empErr } = await employeesQuery;
    if (empErr) return jsonResponse({ error: `failed to load employees: ${empErr.message}` }, 500);
    if (!employees?.length) return jsonResponse({ error: "no employees match" }, 400);

    // Pull statutory identifiers keyed by identifier_type for every employee
    // in this batch. Country-agnostic: whatever the pack registered
    // (KRA_PIN, NSSF_NUMBER, SHIF_NUMBER, NHIF_NUMBER, …) is spread onto
    // the employee context so templates can address `employee.<type>`
    // uniformly. `tax_pin` is kept as an alias for the KRA_PIN identifier
    // to preserve the pre-existing payload shape consumed by templates.
    // Country-agnostic projection via the shared helper (single writer,
    // arch-test locked with generate-statutory-return). Uppercased aliases
    // + tax-identifier aliasing (tax_pin / tax_id / tin) are applied
    // uniformly so pack authors' addressing convention doesn't matter.
    const employeeIdList = employees.map((e: any) => e.id);
    const { data: idRows } = await admin
      .from("employee_statutory_identifiers")
      .select("employee_id, identifier_type, identifier_value")
      .in("employee_id", employeeIdList);
    const projectedById = buildProjectedEmployeeMap(employees as any[], (idRows ?? []) as any[]);
    // Overwrite the working employee rows with their projected copies so
    // downstream code (`emp.tax_pin`, `emp.KRA_PIN`, …) sees the same
    // context every other generator sees.
    for (let i = 0; i < employees.length; i++) {
      const proj = projectedById.get((employees[i] as any).id);
      if (proj) (employees as any[])[i] = proj;
    }

    const branding = await getOrganizationBranding(admin, body.organization_id, body.business_id);
    const orgCurrency = branding?.currencyCode ?? "";

    // Enterprise lifecycle gate — statutory documents can only be issued
    // from a *frozen* payroll history. Mirrors SAP HCM `PC00_M99_CIPE`,
    // Workday "Complete", Odoo `state='done'`, Oracle HCM
    // `Verified`/`Prepayments`. The shared module lives at
    // `_shared/payrollLifecycleGate.ts` so every generator uses the exact
    // same rules — no per-generator drift.
    {
      const gate = await requireApprovedRunsForYear(admin, {
        organization_id: body.organization_id,
        business_id: body.business_id,
        fy: body.fiscal_year,
      });
      if (!gate.ok) {
        return businessError(
          gate.code === "LIFECYCLE_QUERY_FAILED" ? 500 : 422,
          gate.code ?? "LIFECYCLE_REFUSED",
          gate.message ?? "Payroll lifecycle preconditions were not met.",
          gate.recovery ?? "Complete the outstanding payroll approvals, then retry.",
          {
            template_code: body.template_code,
            fiscal_year: body.fiscal_year,
            ...(gate.details ?? {}),
          },
        );
      }
    }

    const created: any[] = [];
    const errors: any[] = [];
    const skipped: any[] = [];

    // F5: one batch_id per invocation so the UI can group "year-end batch of
    // 200 certificates" instead of showing a flat list. Stable across the
    // whole loop; idempotent skips inherit the original batch on regenerate.
    const batchId = crypto.randomUUID();
    for (const emp of employees) {
      try {
        // Idempotency: if an issued cert already exists for this
        // (employee, template, fiscal_year) and the caller didn't ask to
        // regenerate, return the existing one instead of hitting the
        // unique-constraint and surfacing a confusing error.
        if (!body.regenerate) {
          const { data: existing } = await admin
            .from("payroll_tax_certificates")
            .select("id, serial_number, artifacts, fiscal_year, employee_id, template_code, status, batch_id, stale, stale_reason, payload")
            .eq("organization_id", body.organization_id)
            .eq("business_id", body.business_id)
            .eq("employee_id", emp.id)
            .eq("template_code", template.code)
            .eq("fiscal_year", body.fiscal_year)
            .eq("status", "issued")
            .maybeSingle();
          if (existing) {
            const expectedPage = normalizeTemplatePage(template.body);
            const existingPayload = (existing as any).payload ?? {};
            const existingPage = normalizeTemplatePage({ page: existingPayload.template_page });
            const needsRerender =
              (existing as any).stale === true ||
              existingPayload.certificate_renderer_version !== CERTIFICATE_RENDERER_VERSION ||
              existingPayload.template_body_hash !== templateBodyHash ||
              existingPage.orientation !== expectedPage.orientation ||
              existingPage.size !== expectedPage.size;

            if (!needsRerender) {
              skipped.push({ ...existing, reason: "already_issued" });
              continue;
            }

            await admin
              .from("payroll_tax_certificates")
              .update({
                status: "superseded",
                stale: true,
                stale_reason: (existing as any).stale ? (existing as any).stale_reason ?? "stale_regenerated" : "renderer_or_template_changed",
                stale_at: new Date().toISOString(),
              })
              .eq("id", (existing as any).id);
          }
        }

        // ADR 0060: certificates read YTD via the shared resolver only.
        // This is the single writer that owns the canonical
        // payroll_employee_ytd_rollup projection + provenance snapshot.
        const source = await resolveCertificateYtd({
          admin,
          organizationId: body.organization_id,
          businessId: body.business_id,
          employeeId: emp.id,
          fiscalYear: body.fiscal_year,
        });
        const rows = source.rows as RollupRow[];
        // Per-employee guard: an employee with no YTD rollup rows for the
        // fiscal year has no payslip lines in an approved run — skip with an
        // actionable message rather than emitting an empty PDF or throwing.
        if (!rows.length) {
          skipped.push({
            employee_id: emp.id,
            employee_number: (emp as any).employee_number ?? null,
            reason: "NO_YTD_DATA",
            message: `No approved payslip lines exist for this employee in FY ${body.fiscal_year}.`,
          });
          continue;
        }

        const provenance = source.provenance;
        const maxPayrollUpdatedAt = provenance.max_payroll_updated_at;
        const totals = source.totals;

        const payload = {
          template_code: template.code,
          template_layout: template.layout,
          template_pack_id: template.pack_id,
          template_source: templateSource,
          template_version: packTemplate.updated_at,
          template_body_hash: templateBodyHash,
          template_page: normalizeTemplatePage(template.body),
          certificate_renderer_version: CERTIFICATE_RENDERER_VERSION,
          override_version: overrideVersion,
          fiscal_year: body.fiscal_year,
          generated_at: new Date().toISOString(),
          employee: {
            // Payload contract (ADR-0060 addendum): every certificate
            // template can rely on these keys existing. Missing source
            // fields resolve to "" so field_grid `.filter(val.trim())`
            // hides them cleanly instead of silently dropping the row.
            id: emp.id,
            full_name: `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim(),
            employee_number: emp.employee_number ?? "",
            tax_pin: emp.tax_pin ?? "",
            national_id: emp.national_id ?? "",
            position: (emp as any).job_position?.name ?? (emp as any).job_title ?? "",
            department: (emp as any).department?.name ?? "",
            hire_date: (emp as any).hire_date ?? "",
            termination_date: (emp as any).termination_date ?? "",
          },
          rollup: rows,
          totals,
        };

        // Body-driven renderer (Round 6, Step 1): if the resolved template
        // carries structured `body.blocks`, render those blocks around the
        // legacy data table. Empty body ⇒ pure legacy path. Unresolved
        // tokens are recorded as `payroll_diagnostics` rows so admins can
        // spot drift after a pack upgrade (ADR 0010).
        const rendered = renderTemplateBody(template.body, payload);
        if (rendered.misses.length > 0) {
          try {
            await admin.from("payroll_diagnostics").insert({
              organization_id: body.organization_id,
              pack_id: template.pack_id ?? null,
              template_code: template.code,
              surface: "certificate",
              severity: "warning",
              code: "TOKEN_UNRESOLVED",
              message: `Unresolved tokens: ${rendered.misses.join(", ")}`,
              details: { tokens: rendered.misses },
            });
          } catch { /* never break rendering on diagnostics */ }
        }

        // ADR 0060 v2026.4.0 — the legacy baseSummary triad
        // (deductions / employer contributions / taxable income) was a
        // payslip concept masquerading as a statutory footer. Totals
        // now come exclusively from the template's `totals` section
        // via renderCertificateSections. The structural refusal above
        // guarantees a `totals` section is always present, so
        // sections.totalsRows will not be empty.

        // ADR-0060 Wave 8 — Dedicated certificate renderer.
        // The template's `body.sections[]` (already validated by the
        // `certificate_template_v2` schema trigger) is rendered by
        // `renderCertificatePdf`, which draws each section as its own
        // visual band (identity, period, monthly grid, totals, relief,
        // footnote, signature). We no longer flatten sections into the
        // generic report PDF — that path collapsed identity + signature
        // bands into a tiny bottom summary strip and produced the
        // "shallow document" tenants complained about.
        const sectionsSpec = (template.body && Array.isArray((template.body as any).sections))
          ? (template.body as any).sections as any[]
          : [];
        // ADR-0060 addendum: v2 templates express monthly grids as
        // TableBlocks with data_source in {"monthly_breakdown","monthly_matrix"}.
        // We collect rule codes from both legacy sections[] and blocks[]
        // so the RPC returns everything the renderer will bind against.
        const blocksSpec = (template.body && Array.isArray((template.body as any).blocks))
          ? (template.body as any).blocks as any[]
          : [];

        // Pull monthly rows once for every rule_code referenced by any
        // monthly_breakdown/monthly_matrix section or block.
        let monthlyRows: MonthlyRow[] = [];
        const codesFromSections = sectionsSpec
          .filter((s: any) => s?.type === "monthly_breakdown")
          .flatMap((s: any) => {
            const fromCodes = Array.isArray(s.rule_codes) ? s.rule_codes as string[] : [];
            const fromCols = Array.isArray(s.columns)
              ? (s.columns as any[])
                  .map((c) => typeof c === "string" ? c : String(c?.key ?? c?.rule_code ?? ""))
                  .filter(Boolean)
              : [];
            return [...fromCodes, ...fromCols];
          });
        const codesFromBlocks = blocksSpec
          .filter((b: any) => b?.type === "table"
            && (b.data_source === "monthly_breakdown" || b.data_source === "monthly_matrix"))
          .flatMap((b: any) => {
            const derivedKeys = new Set(
              (Array.isArray(b.derived_columns) ? b.derived_columns : [])
                .map((d: any) => String(d?.key ?? "")).filter(Boolean),
            );
            const derivedArgs = (Array.isArray(b.derived_columns) ? b.derived_columns : [])
              .flatMap((d: any) => Array.isArray(d?.args) ? d.args : [])
              .filter((a: any) => typeof a === "string")
              .map((a: string) => a)
              .filter((k: string) => k && k !== "month_index" && !derivedKeys.has(k));
            const fromCols = Array.isArray(b.columns)
              ? (b.columns as any[])
                  .map((c) => String(c?.source_key ?? c?.rule_code ?? c?.key ?? ""))
                  .filter((k) => k && k !== "month_index" && !derivedKeys.has(k))
              : [];
            const explicit = Array.isArray(b.rule_codes) ? b.rule_codes.map((k: any) => String(k)).filter(Boolean) : [];
            return [...fromCols, ...derivedArgs, ...explicit];
          });
        const allMonthlyRuleCodes = isV2BlockTemplate(template) ? codesFromBlocks : [...codesFromSections, ...codesFromBlocks];
        if (allMonthlyRuleCodes.length) {
          const { data: monthly } = await admin.rpc("payroll_employee_monthly_breakdown", {
            p_year: body.fiscal_year,
            p_employee_id: emp.id,
            p_rule_codes: Array.from(new Set(allMonthlyRuleCodes)),
          });
          monthlyRows = (monthly ?? []) as MonthlyRow[];
        }

        // Record any unresolved footer-note tokens as diagnostics but
        // never surface them into the rendered PDF (the dedicated
        // renderer owns footnote layout).
        if (rendered.misses.length > 0) {
          // already logged above via TOKEN_UNRESOLVED insert
        }

        // STATUTORY PAPER PIN — annual employee tax certificates are filed
        // and audited at A4. Orientation is template-owned; tenant
        // print policies cannot override either dimension.
        const _tplPage = (packTemplate as any)?.body?.page ?? {};
        const _tplLandscape =
          String(_tplPage.orientation ?? "portrait").toLowerCase() === "landscape";
        assertStatutoryPaper(_tplLandscape ? "a4-landscape" : "a4");

        // Fetch statutory authority name (if any) for masthead legal citation.
        let authorityName: string | null = null;
        if ((packTemplate as any).authority_id) {
          const { data: auth } = await admin
            .from("statutory_authorities")
            .select("display_name")
            .eq("id", (packTemplate as any).authority_id)
            .maybeSingle();
          authorityName = (auth as any)?.display_name ?? null;
        }

        const serial = makeSerial(body.organization_id, emp.id, body.fiscal_year, template.code);

        // Resolve declared outputs. Publishers can list one or many
        // formats on `template.outputs`; falling back to the historic
        // one-format-per-body-kind default means legacy pack rows keep
        // working. Every entry must have a `format` string that lives in
        // `format_registry` (trigger-enforced at pack save time).
        const declaredOutputs: Array<{
          format: string;
          role?: string;
          label?: string | null;
          filename?: string | null;
        }> = Array.isArray((template as any).outputs) && (template as any).outputs.length
          ? ((template as any).outputs as any[]).map((o) => ({
              format: String(o?.format ?? ""),
              role: o?.role ? String(o.role) : undefined,
              label: o?.label ?? null,
              filename: o?.filename ?? null,
            })).filter((o) => o.format)
          : [{
              format: "pdf",
              role: "primary",
              label: null,
              filename: null,
            }];

        // Render lazily and cache — a pack that declares both `pdf` and
        // `xlsx` still renders each engine only once. Renderers are pure:
        // same v2 sections + same resolved payload ⇒ same bytes.
        let pdfBytes: Uint8Array | null = null;
        let xlsxBytes: Uint8Array | null = null;
        let htmlBytes: Uint8Array | null = null;

        const enginePayload = {
          employee: {
            id: emp.id,
            full_name: payload.employee.full_name,
            employee_number: payload.employee.employee_number,
            tax_pin: payload.employee.tax_pin,
            national_id: payload.employee.national_id,
            position: payload.employee.position,
            department: payload.employee.department,
            hire_date: (emp as any).hire_date ?? null,
            exit_date: (emp as any).termination_date ?? null,
          },
          employer: {
            name: branding?.name ?? "",
            tax_pin: (branding as any)?.tax_pin ?? "",
            address: (branding as any)?.address ?? "",
            tax_office: (branding as any)?.tax_office ?? "",
            phone: (branding as any)?.phone ?? "",
            email: (branding as any)?.email ?? "",
          },
          fiscal_year: body.fiscal_year,
          period_label: `1 Jan ${body.fiscal_year} - 31 Dec ${body.fiscal_year}`,
          currency: orgCurrency,
          monthly: monthlyRows,
          ytdRows: rows.map((r) => ({
            rule_code: r.rule_code,
            category: r.category,
            employee_amount: Number(r.employee_amount) || 0,
            employer_amount: Number(r.employer_amount) || 0,
            taxable_amount: Number(r.taxable_amount) || 0,
          })),
          totals,
          serial_number: serial,
          generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        };

        // v3 data assembly: pivot the raw monthly rule-code stream into the
        // semantic matrix rows the template binds to (e.g. `p9.months`),
        // applying the pack's derived columns. The country's tax math lives
        // entirely in the pack-authored matrix node — this code is generic.
        if (isV3EngineTemplate(template)) {
          const doc = Array.isArray((template.body as any).document)
            ? (template.body as any).document
            : [];
          const matrixNode = doc.find((n: any) => n?.type === "matrix");
          if (matrixNode) {
            const codes = collectMatrixRuleCodes(matrixNode);
            let v3Monthly: any[] = [];
            if (codes.length) {
              const { data: mm } = await admin.rpc("payroll_employee_monthly_breakdown", {
                p_year: body.fiscal_year,
                p_employee_id: emp.id,
                p_rule_codes: codes,
              });
              v3Monthly = (mm ?? []) as any[];
            }
            const matrixRows = buildMatrixRows(v3Monthly, matrixNode);
            // Bind the rows at the template's rows_binding path (dot path).
            const bindingPath = String(matrixNode.rows_binding ?? "matrix.rows");
            const parts = bindingPath.split(".");
            let cursor: any = enginePayload as any;
            for (let i = 0; i < parts.length - 1; i++) {
              if (typeof cursor[parts[i]] !== "object" || cursor[parts[i]] == null) {
                cursor[parts[i]] = {};
              }
              cursor = cursor[parts[i]];
            }
            cursor[parts[parts.length - 1]] = matrixRows;
            // Summary totals the template binds (Col. K / Col. O).
            (enginePayload as any).totals = {
              ...(enginePayload as any).totals,
              chargeable_pay: sumMatrixColumn(matrixRows, "chargeable_pay"),
              paye: sumMatrixColumn(matrixRows, "paye_net"),
            };
          }
        }


        // Certificate Engine v3: the audited artifact is the compiled
        // HTML (CSS Paged Media). It is byte-identical to what the
        // publisher sees in the editor preview AND to what the tenant
        // materialises to a vector PDF client-side (paged.js + browser
        // print). This is the single render path — no pdf-lib redraw, so
        // "preview === output" holds by construction. Legacy (pre-v3)
        // templates still fall back to the block/section pdf-lib renderer
        // until their pack rows are migrated to a v3 document AST.
        const v3 = isV3EngineTemplate(template);

        const renderHtml = (): Uint8Array => {
          const v3Template = {
            schema_version: 3,
            code: template.code,
            display_name: template.display_name,
            paper_format: (template.body as any).paper_format,
            page_master: (template.body as any).page_master,
            document: (template.body as any).document,
          } as CertificateTemplateV3;
          const { html } = compileCertificateHtml(
            v3Template,
            enginePayload as unknown as Record<string, unknown>,
            { currency: orgCurrency },
          );
          return new TextEncoder().encode(html);
        };

        const renderPdf = async () => {
          return await renderCertificatePdf(
          {
            code: template.code,
            display_name: template.display_name,
            legal_reference: (packTemplate as any).legal_reference ?? null,
            regulation_citation: (packTemplate as any).regulation_citation ?? null,
            effective_date: (packTemplate as any).effective_date ?? null,
            authority_name: authorityName,
            body: template.body as any,
          },
          enginePayload as any,
          { branding: branding ?? null },
          );
        };

        const basePath = `${body.organization_id}/payroll/tax-certificates/${body.fiscal_year}/${template.code}/${serial}`;
        const artifactsList: CertificateArtifact[] = [];
        let pdfPath: string | null = null;

        for (const decl of declaredOutputs) {
          let bytes: Uint8Array;
          let ext: string;
          let mime: string;
          // The produced format can differ from the *declared* format: a
          // pack that declares `pdf` on a v3 template is served the
          // compiled HTML (the tenant materialises the vector PDF in the
          // browser). Everything downstream keys off `producedFormat`.
          let producedFormat: string = decl.format;
          if (decl.format === "xlsx") {
            // Odoo-model editable twin. Consumes the SAME v2 sections
            // and the SAME resolved payload as the PDF renderer — no
            // separate data source, no master workbook.
            if (!xlsxBytes) {
              xlsxBytes = await renderCertificateXlsx(
                {
                  code: template.code,
                  display_name: template.display_name,
                  legal_reference: (packTemplate as any).legal_reference ?? null,
                  regulation_citation: (packTemplate as any).regulation_citation ?? null,
                  effective_date: (packTemplate as any).effective_date ?? null,
                  authority_name: authorityName,
                  body: template.body as any,
                },
                {
                  employee: {
                    id: emp.id,
                    full_name: payload.employee.full_name,
                    employee_number: payload.employee.employee_number,
                    tax_pin: payload.employee.tax_pin,
                    national_id: payload.employee.national_id,
                    position: payload.employee.position,
                    department: payload.employee.department,
                    hire_date: (emp as any).hire_date ?? null,
                    exit_date: (emp as any).termination_date ?? null,
                  },
                  employer: {
                    name: branding?.name ?? "",
                    tax_pin: (branding as any)?.tax_pin ?? "",
                    address: (branding as any)?.address ?? "",
                    tax_office: (branding as any)?.tax_office ?? "",
                    phone: (branding as any)?.phone ?? "",
                    email: (branding as any)?.email ?? "",
                  },
                  fiscal_year: body.fiscal_year,
                  period_label: `1 Jan ${body.fiscal_year} - 31 Dec ${body.fiscal_year}`,
                  currency: orgCurrency,
                  monthly: monthlyRows,
                  ytdRows: rows.map((r) => ({
                    rule_code: r.rule_code,
                    category: r.category,
                    employee_amount: Number(r.employee_amount) || 0,
                    employer_amount: Number(r.employer_amount) || 0,
                    taxable_amount: Number(r.taxable_amount) || 0,
                  })),
                  totals,
                  serial_number: serial,
                  generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
                },
              );
            }
            bytes = xlsxBytes;
            ext = "xlsx";
            mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
          } else if (decl.format === "pdf" || decl.format === "html") {
            if (v3) {
              // v3 audited artifact = compiled HTML; the browser produces
              // the vector PDF on download/print.
              if (!htmlBytes) htmlBytes = renderHtml();
              bytes = htmlBytes;
              ext = "html";
              mime = "text/html; charset=utf-8";
              producedFormat = "html";
            } else {
              if (!pdfBytes) pdfBytes = await renderPdf();
              bytes = pdfBytes;
              ext = "pdf";
              mime = "application/pdf";
              producedFormat = "pdf";
            }
          } else {
            // Unknown/unsupported writer for certificates. The trigger on
            // pack save should have caught this, but we defensively skip
            // and record a diagnostic so publishers see it.
            try {
              await admin.from("payroll_diagnostics").insert({
                organization_id: body.organization_id,
                pack_id: template.pack_id ?? null,
                template_code: template.code,
                surface: "certificate",
                severity: "error",
                code: "CERT_OUTPUT_UNSUPPORTED",
                message: `Certificate output format '${decl.format}' has no renderer.`,
                details: { format: decl.format, template_code: template.code },
              });
            } catch { /* diagnostics best-effort */ }
            continue;
          }

          const storagePath = decl.filename
            ? `${body.organization_id}/payroll/tax-certificates/${body.fiscal_year}/${template.code}/${decl.filename}`
            : `${basePath}.${ext}`;
          const up = await admin.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, new Blob([bytes], { type: mime }), {
              contentType: mime,
              upsert: true,
            });
          if (up.error) {
            throw new Error(`upload failed (${decl.format}): ${up.error.message}`);
          }

          artifactsList.push({
            format: producedFormat,
            path: storagePath,
            mime,
            ext,
            size: bytes.byteLength,
            role: decl.role ?? (producedFormat === "xlsx" ? "primary" : "human_readable"),
            generated_at: new Date().toISOString(),
            label: decl.label ?? null,
          });

          // `pdf_path` is a legacy scalar mirror. For v3 (HTML) certificates
          // there is no server PDF; the artifact list is canonical and the
          // client renders the PDF on demand, so leave the mirror null.
          if (producedFormat === "pdf") pdfPath = storagePath;

        }

        if (artifactsList.length === 0) {
          throw new Error(
            `NO_ARTIFACTS_PRODUCED: template '${template.code}' resolved to zero renderable outputs.`,
          );
        }

        // Supersede prior issued row if regenerating
        if (body.regenerate) {
          const { data: prior } = await admin
            .from("payroll_tax_certificates")
            .select("id")
            .eq("organization_id", body.organization_id)
            .eq("business_id", body.business_id)
            .eq("employee_id", emp.id)
            .eq("template_code", template.code)
            .eq("fiscal_year", body.fiscal_year)
            .eq("status", "issued")
            .maybeSingle();
          if (prior?.id) {
            await admin
              .from("payroll_tax_certificates")
              .update({ status: "superseded" })
              .eq("id", prior.id);
          }
        }

        const { data: inserted, error: insErr } = await admin
          .from("payroll_tax_certificates")
          .insert({
            organization_id: body.organization_id,
            business_id: body.business_id,
            branch_id: emp.branch_id,
            employee_id: emp.id,
            template_code: template.code,
            template_pack_id: template.pack_id,
            fiscal_year: body.fiscal_year,
            payload,
            // Backward-compatibility mirror only. `artifacts` is canonical;
            // xlsx files are intentionally not written to legacy scalars.
            pdf_path: pdfPath,
            artifacts: artifactsList,
            serial_number: serial,
            status: "issued",
            generated_by: userId,
            batch_id: batchId,
            provenance: {
              ...provenance,
              // ADR-0060 Phase F: stamp the renderer version so the
              // staleness sweep (`payroll_supersede_v1_certificates`)
              // can skip certificates already produced by V2.
              renderer:
                isV3EngineTemplate(template)
                  ? "v3-html"
                  : Number((template.body as any)?.schema_version ?? 1) >= 2
                    ? "v2"
                    : "v1",
            },
          })
          .select("id, serial_number, artifacts, fiscal_year, employee_id, template_code, status, batch_id")
          .single();
        if (insErr) throw new Error(insErr.message);
        created.push(inserted);
      } catch (e: any) {
        errors.push({ employee_id: emp.id, error: e?.message ?? String(e) });
      }
    }

    // When every employee failed, surface the first failure as a
    // structured business error so the UI can render the real reason
    // (e.g. NO_YTD_DATA / TEMPLATE_STRUCTURAL_INVALID) instead of
    // "unexpected error".
    if (errors.length && !created.length && !skipped.length) {
      const first = errors[0]?.error ?? "unknown";
      const msg = String(first);
      const codeMatch = msg.match(/^([A-Z_][A-Z0-9_]+):/);
      const code = codeMatch ? codeMatch[1] : "CERT_GENERATE_FAILED";
      return businessError(
        500,
        code,
        `Certificate generation failed for every requested employee. First error: ${msg}`,
        "Review the error detail and address the underlying data or configuration issue, then retry generation.",
        { template_code: template.code, batch_id: batchId, errors },
      );
    }
    return jsonResponse(
      { created, skipped, errors, template_code: template.code, batch_id: batchId },
      200,
    );
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    const codeMatch = msg.match(/^([A-Z_][A-Z0-9_]+):/);
    const code = codeMatch ? codeMatch[1] : "CERT_GENERATE_UNEXPECTED";
    return jsonResponse(
      {
        error: code,
        code,
        message: msg,
        recovery: "Check the edge-function logs for the full stack trace and address the underlying error.",
      },
      500,
    );
  }
});

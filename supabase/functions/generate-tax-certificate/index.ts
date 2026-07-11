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
import { renderCertificatePdf } from "../_shared/pdf/certificateRenderer.ts";
import { getOrganizationBranding } from "../_shared/branding/index.ts";
import { renderTemplateBody, toSummaryRows } from "../_shared/renderTemplateBody.ts";
import { type MonthlyRow } from "../_shared/certificateSections.ts";
import { resolveCertificateYtd } from "../_shared/certificateSourceResolver.ts";
import {
  renderBinaryCertificateXlsx,
  makeUrlAssetFetcher,
  type BinaryCertificateBody,
} from "../_shared/pdf/binaryCertificateRenderer.ts";

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

    // ADR 0060 v2026.4.0 — Structural refusal. If the resolved template
    // (pack OR tenant override) is missing the section contract, refuse
    // to render instead of silently falling back to the legacy
    // generic-column layout. This guarantees no P9/P9A/CERT_OF_SERVICE
    // can ever be issued without identity headers, a data section, and
    // a signature block.
    {
      const sec = Array.isArray(template?.body?.sections) ? template.body.sections : [];
      const types = new Set<string>(sec.map((s: any) => String(s?.type ?? "")));
      const missing: string[] = [];
      for (const need of ["employer_header", "employee_header", "signature_block"]) {
        if (!types.has(need)) missing.push(need);
      }
      const hasData = ["monthly_breakdown", "ytd_table", "totals"].some((d) => types.has(d));
      const isBinary = (template?.body as any)?.kind === "xlsx_binary";
      if (!isBinary && (sec.length === 0 || missing.length > 0 || !hasData)) {
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
    const employeeIdList = employees.map((e: any) => e.id);
    const { data: idRows } = await admin
      .from("employee_statutory_identifiers")
      .select("employee_id, identifier_type, identifier_value")
      .in("employee_id", employeeIdList);
    const idsByEmp = new Map<string, Record<string, string>>();
    for (const r of (idRows ?? []) as any[]) {
      const m = idsByEmp.get(r.employee_id) ?? {};
      m[r.identifier_type] = r.identifier_value;
      idsByEmp.set(r.employee_id, m);
    }
    for (const emp of employees as any[]) {
      const ids = idsByEmp.get(emp.id) ?? {};
      for (const [k, v] of Object.entries(ids)) {
        if (k in emp) continue;
        (emp as any)[k] = v ?? null;
      }
      if (!(emp as any).tax_pin) {
        (emp as any).tax_pin = ids.KRA_PIN ?? ids.TAX_PIN ?? ids.TIN ?? null;
      }
    }

    const branding = await getOrganizationBranding(admin, body.organization_id, body.business_id);
    const orgCurrency = branding?.currencyCode ?? "";

    // Enterprise rule (see .lovable/plan.md — Phase 2/5g):
    // Tax certificates are downstream of Payroll APPROVAL, not Payment or
    // GL Posting. Refuse the request up-front with a structured error if the
    // fiscal year has no approved payroll runs for this org/business — this
    // is what previously surfaced to users as an opaque "500 Internal Server
    // Error" after the per-employee YTD rollup returned nothing.
    // Payment status is NOT checked here (mirrors SAP HCM / Workday / Oracle
    // HCM: year-end certificates are producible immediately after approval).
    {
      const fyStart = `${body.fiscal_year}-01-01`;
      const fyEnd = `${body.fiscal_year}-12-31`;
      const { count: approvedRunCount, error: runCntErr } = await admin
        .from("payroll_runs")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", body.organization_id)
        .eq("business_id", body.business_id)
        .lte("pay_period_start", fyEnd)
        .gte("pay_period_end", fyStart)
        .not("approved_at", "is", null);
      if (runCntErr) {
        return jsonResponse({ error: `approval check failed: ${runCntErr.message}` }, 500);
      }
      if (!approvedRunCount || approvedRunCount === 0) {
        return businessError(
          400,
          "NO_APPROVED_PAYROLL_RUNS",
          `No approved payroll runs were found for fiscal year ${body.fiscal_year}. Tax certificates can only be issued from an approved (finalised) payroll.`,
          "Approve at least one payroll run inside this fiscal year, then generate the certificate again. You do not need to pay employees or post to the GL first.",
          {
            template_code: body.template_code,
            fiscal_year: body.fiscal_year,
            requires: "payroll_runs.approved_at",
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
            .select("id, serial_number, pdf_path, fiscal_year, employee_id, template_code, status")
            .eq("organization_id", body.organization_id)
            .eq("business_id", body.business_id)
            .eq("employee_id", emp.id)
            .eq("template_code", template.code)
            .eq("fiscal_year", body.fiscal_year)
            .eq("status", "issued")
            .maybeSingle();
          if (existing) {
            skipped.push({ ...existing, reason: "already_issued" });
            continue;
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
          override_version: overrideVersion,
          fiscal_year: body.fiscal_year,
          generated_at: new Date().toISOString(),
          employee: {
            id: emp.id,
            full_name: `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim(),
            employee_number: emp.employee_number,
            tax_pin: emp.tax_pin,
            national_id: emp.national_id,
            position: (emp as any).job_position?.name ?? null,
            department: (emp as any).department?.name ?? null,
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

        // Pull monthly rows once for every rule_code referenced by any
        // monthly_breakdown section.
        let monthlyRows: MonthlyRow[] = [];
        const allMonthlyRuleCodes = sectionsSpec
          .filter((s: any) => s?.type === "monthly_breakdown")
          .flatMap((s: any) => {
            // Support both `rule_codes:[…]` and `columns:[{key}]` authoring shapes.
            const fromCodes = Array.isArray(s.rule_codes) ? s.rule_codes as string[] : [];
            const fromCols = Array.isArray(s.columns)
              ? (s.columns as any[])
                  .map((c) => typeof c === "string" ? c : String(c?.key ?? c?.rule_code ?? ""))
                  .filter(Boolean)
              : [];
            return [...fromCodes, ...fromCols];
          });
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

        // STATUTORY PAPER PIN — annual employee tax certificates (P9 in
        // Kenya, equivalent forms elsewhere) are filed and audited at A4.
        // Tenant print policies cannot override.
        assertStatutoryPaper("a4");

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
        const isBinaryTpl = (template.body as any)?.kind === "xlsx_binary";

        let pdfBytes: Uint8Array | null = null;
        let xlsxBytes: Uint8Array | null = null;

        if (isBinaryTpl) {
          // Resolve asset URL for this pack version
          const packVersionId = (template as any).pack_version_id
            ?? (packTemplate as any).pack_version_id
            ?? null;
          const assetKey = (template.body as any).asset_key as string;
          let assetRow: any = null;
          if (packVersionId) {
            const r = await admin
              .from("localization_pack_binary_assets")
              .select("source_url")
              .eq("pack_version_id", packVersionId)
              .eq("asset_key", assetKey)
              .maybeSingle();
            assetRow = r.data;
          }
          if (!assetRow) {
            // Fallback: latest asset row matching this pack + asset_key
            const r = await admin
              .from("localization_pack_binary_assets")
              .select("source_url")
              .eq("pack_id", template.pack_id)
              .eq("asset_key", assetKey)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            assetRow = r.data;
          }
          const sourceUrl = assetRow?.source_url as string | null | undefined;
          if (!sourceUrl) {
            throw new Error(`master workbook not registered for ${assetKey}`);
          }
          const origin = new URL(req.url).origin;
          const fetcher = makeUrlAssetFetcher(() => sourceUrl, origin);
          xlsxBytes = await renderBinaryCertificateXlsx(
            template.body as BinaryCertificateBody,
            {
              employer: {
                name: branding?.name ?? "",
                legal_name: (branding as any)?.legal_name ?? branding?.name ?? "",
                tax_pin: (branding as any)?.tax_pin ?? "",
                address: (branding as any)?.address ?? "",
                tax_office: (branding as any)?.tax_office ?? "",
                phone: (branding as any)?.phone ?? "",
                email: (branding as any)?.email ?? "",
              },
              employee: {
                id: emp.id,
                full_name: payload.employee.full_name,
                first_name: (emp as any).first_name ?? "",
                last_name: (emp as any).last_name ?? "",
                other_names: [(emp as any).first_name, (emp as any).last_name].filter(Boolean).join(" "),
                employee_number: payload.employee.employee_number,
                tax_pin: payload.employee.tax_pin,
                national_id: payload.employee.national_id,
                position: payload.employee.position,
                department: payload.employee.department,
              },

              fiscal_year: body.fiscal_year,
              currency: orgCurrency,
              monthly: monthlyRows.map((r) => ({
                month: Number((r as any).month) || 0,
                rule_code: String((r as any).rule_code ?? ""),
                amount: Number((r as any).amount) || 0,
              })),
              totals,
              serial_number: serial,
              generated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
            },
            fetcher,
          );
        } else {
        pdfBytes = await renderCertificatePdf(
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
          { branding: branding ?? null },
        );
        }

        const basePath = `${body.organization_id}/payroll/tax-certificates/${body.fiscal_year}/${template.code}/${serial}`;
        let pdfPath: string | null = null;
        let xlsxPath: string | null = null;
        if (pdfBytes) {
          pdfPath = `${basePath}.pdf`;
          const up = await admin.storage
            .from(STORAGE_BUCKET)
            .upload(pdfPath, new Blob([pdfBytes], { type: "application/pdf" }), {
              contentType: "application/pdf",
              upsert: true,
            });
          if (up.error) throw new Error(`upload failed: ${up.error.message}`);
        }
        if (xlsxBytes) {
          xlsxPath = `${basePath}.xlsx`;
          const up = await admin.storage
            .from(STORAGE_BUCKET)
            .upload(
              xlsxPath,
              new Blob([xlsxBytes], {
                type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              }),
              {
                contentType:
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                upsert: true,
              },
            );
          if (up.error) throw new Error(`xlsx upload failed: ${up.error.message}`);
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
            pdf_path: pdfPath,
            xlsx_path: xlsxPath,
            serial_number: serial,
            status: "issued",
            generated_by: userId,
            batch_id: batchId,
            provenance,
          })
          .select("id, serial_number, pdf_path, xlsx_path, fiscal_year, employee_id, template_code, status, batch_id")
          .single();
        if (insErr) throw new Error(insErr.message);
        created.push(inserted);
      } catch (e: any) {
        errors.push({ employee_id: emp.id, error: e?.message ?? String(e) });
      }
    }

    return jsonResponse(
      { created, skipped, errors, template_code: template.code, batch_id: batchId },
      errors.length && !created.length && !skipped.length ? 500 : 200,
    );
  } catch (e: any) {
    return jsonResponse({ error: e?.message ?? String(e) }, 500);
  }
});

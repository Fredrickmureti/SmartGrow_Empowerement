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
import { getOrganizationBranding } from "../_shared/branding/index.ts";
import { renderTemplateBody, toSummaryRows } from "../_shared/renderTemplateBody.ts";
import { renderCertificateSections, type MonthlyRow } from "../_shared/certificateSections.ts";

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
    if (!packTemplate) return jsonResponse({ error: `template not found: ${body.template_code}` }, 404);

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

    // Resolve employees
    // Wave 1.1: position/department resolved via FK joins (legacy text cols dropped)
    let employeesQuery = admin
      .from("employees")
      .select("id, first_name, last_name, employee_number, tax_pin, national_id:national_id, email, branch_id, business_id, organization_id, department:departments(name), job_position:job_positions(name)")
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

    const branding = await getOrganizationBranding(admin, body.organization_id, body.business_id);
    const orgCurrency = branding?.currencyCode ?? "";

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

        const { data: rollup, error: rollErr } = await admin.rpc("payroll_employee_ytd_rollup", {
          p_year: body.fiscal_year,
          p_employee_id: emp.id,
        });
        if (rollErr) throw new Error(rollErr.message);
        const rows = (rollup ?? []) as RollupRow[];

        // Provenance snapshot (Step 2): captures the high-water mark of the
        // payroll surface that produced this certificate. payroll_mark_stale_certificates
        // compares this against current MAX(updated_at) and flips `stale=true`
        // if any underlying run/payslip has changed since issuance.
        const { data: runRows } = await admin
          .from("payroll_runs")
          .select("id, updated_at, pay_period_end")
          .eq("organization_id", body.organization_id)
          .eq("business_id", body.business_id);
        const fyRuns = (runRows ?? []).filter(
          (r: any) => r.pay_period_end && new Date(r.pay_period_end).getUTCFullYear() === body.fiscal_year,
        );
        const { data: slipRows } = await admin
          .from("payslips")
          .select("id, updated_at, payroll_run_id")
          .eq("organization_id", body.organization_id)
          .eq("business_id", body.business_id)
          .eq("employee_id", emp.id)
          .in("payroll_run_id", fyRuns.map((r: any) => r.id).length ? fyRuns.map((r: any) => r.id) : ["00000000-0000-0000-0000-000000000000"]);
        const maxRunTs = fyRuns.reduce((m: number, r: any) => Math.max(m, new Date(r.updated_at).getTime()), 0);
        const maxSlipTs = (slipRows ?? []).reduce((m: number, r: any) => Math.max(m, new Date(r.updated_at).getTime()), 0);
        const maxPayrollUpdatedAt = new Date(Math.max(maxRunTs, maxSlipTs, 0)).toISOString();
        const provenance = {
          run_ids: fyRuns.map((r: any) => r.id),
          payslip_ids: (slipRows ?? []).map((r: any) => r.id),
          max_payroll_updated_at: maxPayrollUpdatedAt,
          snapshot_at: new Date().toISOString(),
        };

        const totals = rows.reduce(
          (acc, r) => {
            acc.employee += Number(r.employee_amount) || 0;
            acc.employer += Number(r.employer_amount) || 0;
            acc.taxable += Number(r.taxable_amount) || 0;
            return acc;
          },
          { employee: 0, employer: 0, taxable: 0 },
        );

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

        const baseSummary: Array<{ label: string; value: string }> = [
          { label: "Total employee deductions", value: fmtMoney(totals.employee, orgCurrency) },
          { label: "Total employer contributions", value: fmtMoney(totals.employer, orgCurrency) },
          { label: "Total taxable income", value: fmtMoney(totals.taxable, orgCurrency) },
        ];

        // Sections renderer (Wave 7 / P1.1): if the resolved template carries
        // `body.sections[]`, project them into PDF primitives. This is what
        // makes KE P9 produce its 12-row monthly grid instead of falling back
        // to the generic YTD rule table.
        const sectionsSpec = (template.body && Array.isArray((template.body as any).sections))
          ? (template.body as any).sections
          : null;
        let monthlyRows: MonthlyRow[] = [];
        if (sectionsSpec) {
          const allRuleCodes = sectionsSpec
            .filter((s: any) => s?.type === "monthly_breakdown" && Array.isArray(s.rule_codes))
            .flatMap((s: any) => s.rule_codes as string[]);
          if (allRuleCodes.length) {
            const { data: monthly } = await admin.rpc("payroll_employee_monthly_breakdown", {
              p_year: body.fiscal_year,
              p_employee_id: emp.id,
              p_rule_codes: Array.from(new Set(allRuleCodes)),
            });
            monthlyRows = (monthly ?? []) as MonthlyRow[];
          }
        }
        const sections = renderCertificateSections(sectionsSpec, {
          employee: payload.employee as any,
          ytdRows: rows.map((r) => ({
            rule_code: r.rule_code,
            category: r.category,
            employee_amount: Number(r.employee_amount) || 0,
            employer_amount: Number(r.employer_amount) || 0,
            taxable_amount: Number(r.taxable_amount) || 0,
          })),
          monthly: monthlyRows,
          totals,
          currency: orgCurrency,
          fiscalYear: body.fiscal_year,
        });

        // Render PDF — prefer monthly grid when a section declares one,
        // otherwise fall back to the YTD rule table.
        const useMonthly = !!sections.monthlyTable;
        const pdfPayload: ReportPdfPayload = {
          title: template.display_name,
          subtitle: `Fiscal Year ${body.fiscal_year} — ${payload.employee.full_name}`,
          companyName: branding?.name ?? "",
          organization: branding ?? undefined,
          currency: orgCurrency,
          columns: useMonthly ? sections.monthlyTable!.columns : [
            { key: "rule_code", header: "Rule", align: "left" },
            { key: "category", header: "Category", align: "left" },
            { key: "employee_amount", header: "Employee", align: "right", format: "money" },
            { key: "employer_amount", header: "Employer", align: "right", format: "money" },
            { key: "taxable_amount", header: "Taxable", align: "right", format: "money" },
          ],
          rows: useMonthly ? sections.monthlyTable!.rows : rows.map((r) => ({
            rule_code: r.rule_code,
            category: r.category ?? "",
            employee_amount: Number(r.employee_amount) || 0,
            employer_amount: Number(r.employer_amount) || 0,
            taxable_amount: Number(r.taxable_amount) || 0,
          })),
          summaryRows: [
            ...toSummaryRows(rendered.beforeTable),
            ...sections.headerRows,
            ...(sections.totalsRows.length ? sections.totalsRows : baseSummary),
            ...toSummaryRows(rendered.afterTable),
          ],
          footerNote:
            rendered.footerNote ??
            `Tax Certificate • ${template.code} • FY ${body.fiscal_year}`,
        };
        // STATUTORY PAPER PIN — annual employee tax certificates (P9 in
        // Kenya, equivalent forms elsewhere) are filed and audited at A4.
        // Tenant print policies cannot override.
        assertStatutoryPaper("a4");
        const pdfBytes = await generateReportPdf(pdfPayload);

        const serial = makeSerial(body.organization_id, emp.id, body.fiscal_year, template.code);
        const path = `${body.organization_id}/payroll/tax-certificates/${body.fiscal_year}/${template.code}/${serial}.pdf`;

        const upload = await admin.storage
          .from(STORAGE_BUCKET)
          .upload(path, new Blob([pdfBytes], { type: "application/pdf" }), {
            contentType: "application/pdf",
            upsert: true,
          });
        if (upload.error) throw new Error(`upload failed: ${upload.error.message}`);

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
            pdf_path: path,
            serial_number: serial,
            status: "issued",
            generated_by: userId,
            batch_id: batchId,
            provenance,
          })
          .select("id, serial_number, pdf_path, fiscal_year, employee_id, template_code, status, batch_id")
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

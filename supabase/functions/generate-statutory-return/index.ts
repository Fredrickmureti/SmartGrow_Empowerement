/**
 * generate-statutory-return (R7)
 *
 * Country-agnostic statutory return generator. Resolves a declarative template
 * from `localization_pack_return_templates` (template's `pack_id` matches the
 * org's installed pack, or NULL = generic fallback). Aggregates `payslip_lines`
 * across the requested period filtered by `template.body.filters.rule_codes[]`,
 * projects rows per the declarative `template.body.columns[]`, reconciles the
 * total against `payroll_liabilities.original_amount` for the same rule + period,
 * renders CSV and/or PDF, uploads to the `documents` bucket, and inserts a
 * `payroll_return_runs` row. `regenerate=true` supersedes the prior run; both
 * are retained for audit. NO country-code branches — countries enter only via
 * pack template rows.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { generateReportPdf, type ReportPdfPayload } from "../_shared/reportPdfGenerator.ts";
import { isReturnTemplateV2, renderReturnPdf } from "../_shared/pdf/returnRenderer.ts";
import { assertStatutoryPaper } from "../_shared/pdf/index.ts";
import { getOrganizationBranding } from "../_shared/branding/index.ts";
import { renderGovFile, type GovFileSubmissionFormat } from "../_shared/govFileWriter.ts";
import {
  readSource as resolveSource,
  extractExtraRuleCodes,
  type SourceContext,
} from "../_shared/returnSourceResolver.ts";
import { requireClosedPeriod } from "../_shared/payrollLifecycleGate.ts";
import { buildProjectedEmployeeMap } from "../_shared/employeeStatutoryProjection.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface RequestBody {
  organization_id: string;
  business_id: string;
  template_code: string;
  period_start: string; // YYYY-MM-DD
  period_end: string;   // YYYY-MM-DD
  branch_id?: string | null;
  regenerate?: boolean;
}

interface ColumnSpec {
  key: string;
  source: string; // e.g. 'employee.tax_pin', 'sum_employee_amount', 'sum_employer_amount', 'sum_taxable_amount'
  label?: string;
}

const STORAGE_BUCKET = "documents";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function businessError(
  status: number,
  code: string,
  message: string,
  action: string,
  details: Record<string, unknown> = {},
) {
  return jsonResponse(
    {
      error: code,
      code,
      message,
      action,
      expected: true,
      details,
    },
    status,
  );
}

function makeSerial(code: string, periodEnd: string) {
  const stamp = Date.now().toString(36).toUpperCase();
  return `${code}-${periodEnd}-${stamp}`;
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const readSource = (source: string, ctx: SourceContext) => resolveSource(source, ctx);

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
    if (!body.organization_id || !body.business_id || !body.template_code || !body.period_start || !body.period_end) {
      return businessError(
        400,
        "RETURN_REQUEST_INCOMPLETE",
        "The return cannot be generated because the request is missing required organization, business, template, or period information.",
        "Refresh the page and try again. If this continues, contact your system administrator.",
      );
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Permission gate. RPC signature: (_user_id, _org_id, _module, _operation).
    // Payroll posts to the GL, so we gate on the `financials` module.
    const { data: perm, error: permErr } = await admin.rpc("user_has_module_permission", {
      _user_id: userId,
      _org_id: body.organization_id,
      _module: "financials",
      _operation: "write",
    });
    if (permErr) return jsonResponse({ error: `permission check failed: ${permErr.message}` }, 500);
    if (!perm) return jsonResponse({ error: "permission denied" }, 403);

    // Resolve template: pack-specific then generic fallback
    const { data: orgSetting } = await admin
      .from("installed_localization_packs")
      .select("pack_id")
      .eq("organization_id", body.organization_id)
      .eq("business_id", body.business_id)
      .in("status", ["installed", "active"])
      .maybeSingle();

    let packTemplate: any = null;
    if (orgSetting?.pack_id) {
      const r = await admin
        .from("localization_pack_return_templates")
        .select("*")
        .eq("pack_id", orgSetting.pack_id)
        .eq("code", body.template_code)
        .maybeSingle();
      packTemplate = r.data;
    }
    if (!packTemplate) {
      const r = await admin
        .from("localization_pack_return_templates")
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
        `No statutory return template "${body.template_code}" is available for this business. Install the localization pack that ships this template, or add a tenant override, before generating the return.`,
        "Open Settings → Localization → Packs, install the country pack that provides this return (or create an override in Payroll → Compliance → Return templates), then retry generation.",
        {
          template_code: body.template_code,
          pack_id: orgSetting?.pack_id ?? null,
          requires: "localization_pack_return_templates",
        },
      );
    }

    // Tenant override coalesce: override wins; staleness blocks generation.
    const { data: override } = await admin
      .from("payroll_return_template_overrides")
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
        return businessError(
          409,
          "TEMPLATE_OUT_OF_DATE",
          "This return template has changed since your override was last approved, so the return was not generated.",
          "Review and re-acknowledge the template override, then generate the return again.",
          { template_code: body.template_code },
        );
      }
      // Slice-C: coalesce operational override columns (channel/format/output/
      // due_day/due_month_offset) on top of pack template. Legal metadata
      // (authority_id, legal_reference, effective_date, sunset_date,
      // approval_required, digital_signature_spec, etc.) stays pack-owned.
      const opOverrides: Record<string, any> = {};
      for (const k of [
        "submission_channel",
        "submission_format",
        "output",
        "due_day",
        "due_month_offset",
      ]) {
        if ((override as any)[k] !== null && (override as any)[k] !== undefined) {
          opOverrides[k] = (override as any)[k];
        }
      }
      template = { ...packTemplate, ...opOverrides, body: override.body ?? packTemplate.body };
      templateSource = "override";
      overrideVersion = override.override_version;
    }

    const filters = (template.body?.filters ?? {}) as { rule_codes?: string[]; payslip_status?: string[] };
    const ruleCodes: string[] = Array.isArray(filters.rule_codes) ? filters.rule_codes : [];
    if (!ruleCodes.length) {
      return businessError(
        400,
        "RETURN_TEMPLATE_MISSING_RULES",
        "This return template is not ready for generation because it does not define the statutory payroll rules to report.",
        "Ask an administrator to update the return template rule mapping before generating this return.",
        { template_code: body.template_code },
      );
    }
    const columns: ColumnSpec[] = Array.isArray(template.body?.columns) ? template.body.columns : [];
    if (!columns.length) {
      return businessError(
        400,
        "RETURN_TEMPLATE_MISSING_COLUMNS",
        "This return template is not ready for generation because it does not define any return columns.",
        "Ask an administrator to complete the return template layout before generating this return.",
        { template_code: body.template_code },
      );
    }

    // Enterprise lifecycle gate — statutory returns may only be filed
    // from a closed payroll period. Shared with `generate-tax-certificate`
    // via `_shared/payrollLifecycleGate.ts`. SAP HCM / Workday / Oracle
    // HCM parity: no open period may emit a filable return.
    {
      const gate = await requireClosedPeriod(admin, {
        organization_id: body.organization_id,
        business_id: body.business_id,
        period_start: body.period_start,
        period_end: body.period_end,
      });
      if (!gate.ok) {
        return businessError(
          gate.code === "LIFECYCLE_QUERY_FAILED" ? 500 : 422,
          gate.code ?? "LIFECYCLE_REFUSED",
          gate.message ?? "Payroll lifecycle preconditions were not met.",
          gate.recovery ?? "Close the payroll period, then retry.",
          {
            template_code: body.template_code,
            period_start: body.period_start,
            period_end: body.period_end,
            ...(gate.details ?? {}),
          },
        );
      }
    }

    // Country-agnostic: discover every extra rule_code the template
    // references via `sum_rule.<code>.*` or `sum_taxable_minus_rules:<codes>`
    // and add it to the payslip_lines fetch. filters.rule_codes still
    // governs reconciliation; the extras only populate per-rule sums.
    const extraRuleCodes = extractExtraRuleCodes(columns.map((c) => c.source));
    const allRuleCodes = Array.from(new Set([...ruleCodes, ...extraRuleCodes]));

    // 1) Pull payslips in the period. Enterprise rule (see plan/redesign):
    //    Statutory returns depend ONLY on Payroll Approval — the legal point
    //    at which the run becomes immutable. Payment, GL posting, and bank
    //    file generation are peer workflows and MUST NOT gate returns.
    //    Source of truth: `payroll_runs.approved_at IS NOT NULL`.
    //    Templates can still narrow the payslip set via filters.payslip_status.
    const { data: runs } = await admin
      .from("payroll_runs")
      .select("id, pay_period_start, pay_period_end, status, approved_at")
      .eq("organization_id", body.organization_id)
      .eq("business_id", body.business_id)
      .lte("pay_period_start", body.period_end)
      .gte("pay_period_end", body.period_start)
      .not("approved_at", "is", null);
    const runIds = (runs ?? []).map((r: any) => r.id);
    if (!runIds.length) {
      return businessError(
        400,
        "NO_APPROVED_PAYROLL_RUNS",
        "No approved payroll run was found for this return period. Statutory returns can only be generated from an approved (finalised) payroll.",
        "Approve the payroll run for the selected period, then generate the return again. You do not need to pay employees or post to the GL first.",
        {
          template_code: body.template_code,
          period_start: body.period_start,
          period_end: body.period_end,
          requires: "payroll_runs.approved_at",
        },
      );
    }

    let payslipQ = admin
      .from("payslips")
      .select("id, employee_id, taxable_income, gross_pay, branch_id, status, payroll_run_id")
      .eq("organization_id", body.organization_id)
      .eq("business_id", body.business_id)
      .in("payroll_run_id", runIds);

    if (body.branch_id) payslipQ = payslipQ.eq("branch_id", body.branch_id);
    if (filters.payslip_status?.length) {
      payslipQ = payslipQ.in("status", filters.payslip_status);
    }
    const { data: payslips, error: payslipErr } = await payslipQ;
    if (payslipErr) return jsonResponse({ error: `payslips: ${payslipErr.message}` }, 500);
    if (!payslips?.length) {
      const requiredStatuses = Array.isArray(filters.payslip_status) ? filters.payslip_status : [];
      const statusText = requiredStatuses.length
        ? requiredStatuses.map((s) => String(s).replace(/_/g, " ")).join(", ")
        : "eligible";
      return businessError(
        400,
        "NO_ELIGIBLE_PAYSLIPS",
        requiredStatuses.length
          ? `This return is configured to use ${statusText} payslips only, but none were found in the selected period.`
          : "No eligible payslips were found in the selected period, so the statutory return cannot be generated yet.",
        requiredStatuses.length
          ? "Finalize payroll approval for this period so approved payroll results are available, then generate the return again."
          : "Confirm the payroll run includes payslips for this period, then generate the return again.",
        {
          template_code: body.template_code,
          period_start: body.period_start,
          period_end: body.period_end,
          branch_id: body.branch_id ?? null,
          required_payslip_statuses: requiredStatuses,
          payroll_run_ids: runIds,
        },
      );
    }

    const payslipIds = payslips.map((p: any) => p.id);
    const employeeIds = Array.from(new Set(payslips.map((p: any) => p.employee_id)));

    // 2) Pull payslip_lines. We need EVERY line for these payslips —
    // not just the rule_codes the template targets — because basic /
    // allowance subtotals are derived from `category` and may be needed
    // by columns that reference `sums.basic` / `sums.allowances`. The
    // per-rule breakdown (sums.byRule) is still keyed by rule_code, so
    // template behaviour is unchanged.
    const { data: lines, error: linesErr } = await admin
      .from("payslip_lines")
      .select("payslip_id, employee_id, rule_code, category, employee_amount, employer_amount, scheme_component_id")
      .in("payslip_id", payslipIds);
    if (linesErr) return jsonResponse({ error: `payslip_lines: ${linesErr.message}` }, 500);

    const { data: reportingBindings, error: bindingErr } = await admin
      .from("statutory_reporting_bindings")
      .select("scheme_component_id, column_key, side")
      .eq("return_template_code", template.code);
    if (bindingErr) return jsonResponse({ error: `statutory_reporting_bindings: ${bindingErr.message}` }, 500);
    const bindingsByColumn = new Map<string, { scheme_component_id: string; side: "employee" | "employer" | "total" }>();
    for (const b of (reportingBindings ?? []) as any[]) {
      if (!b?.column_key || !b?.scheme_component_id) continue;
      bindingsByColumn.set(String(b.column_key), {
        scheme_component_id: String(b.scheme_component_id),
        side: b.side === "employer" || b.side === "total" ? b.side : "employee",
      });
    }


    // 3) Pull employees — statutory identifiers (tax_pin, nssf_number,
    //    nhif_number, shif_number) live in employee_statutory_identifiers
    //    keyed by country_code + identifier_type. The dropped columns on
    //    employees are intentionally not selected.
    const { data: employees, error: empErr } = await admin
      .from("employees")
      .select("id, first_name, last_name, employee_number, national_id, branch_id")
      .in("id", employeeIds);
    if (empErr) return jsonResponse({ error: `employees: ${empErr.message}` }, 500);

    const { data: ids, error: idErr } = await admin
      .from("employee_statutory_identifiers")
      .select("employee_id, identifier_type, identifier_value")
      .in("employee_id", employeeIds);
    if (idErr) return jsonResponse({ error: `employee_statutory_identifiers: ${idErr.message}` }, 500);

    // Country-agnostic projection via the shared helper (single writer,
    // arch-test locked). Uppercased aliases and tax-identifier aliasing
    // are applied uniformly with the certificate generator so a template
    // addressing `employee.tax_pin`, `employee.TAX_PIN`, `employee.tax_id`
    // or `employee.tin` all resolve identically.
    const empById = buildProjectedEmployeeMap(employees as any[], (ids ?? []) as any[]);

    // 4) Aggregate per employee — primary sums (employee/employer/taxable
    //    over filters.rule_codes), the per-rule breakdown demanded by the
    //    template, and basic/allowances from the payslip itself.
    const ruleCodeSet = new Set(ruleCodes);
    const emptySums = (): SourceContext["sums"] => ({
      employee: 0, employer: 0, taxable: 0, basic: 0, allowances: 0, payslipCount: 0, byRule: {}, byComponent: {}, byColumn: {},
    });
    const sumsByEmp = new Map<string, SourceContext["sums"]>();
    for (const eid of employeeIds) sumsByEmp.set(eid, emptySums());
    for (const ln of (lines ?? [])) {
      const s = sumsByEmp.get(ln.employee_id) ?? emptySums();
      const empAmt = Number(ln.employee_amount) || 0;
      const erAmt = Number(ln.employer_amount) || 0;
      // Per-rule breakdown for every code we fetched
      const r = s.byRule[ln.rule_code] ?? { employee: 0, employer: 0 };
      r.employee += empAmt;
      r.employer += erAmt;
      s.byRule[ln.rule_code] = r;
      if (ln.scheme_component_id) {
        const componentId = String(ln.scheme_component_id);
        const c = s.byComponent?.[componentId] ?? { employee: 0, employer: 0 };
        c.employee += empAmt;
        c.employer += erAmt;
        (s.byComponent ||= {})[componentId] = c;
      }
      // Primary sums only roll up filters.rule_codes — keeps existing
      // reconciliation semantics intact.
      if (ruleCodeSet.has(ln.rule_code)) {
        s.employee += empAmt;
        s.employer += erAmt;
      }
      // Country-agnostic basic / allowances: derived from `category`,
      // not from any country-specific header column. `basic` and
      // `allowance` are universal payslip_line categories written by the
      // payroll engine regardless of jurisdiction.
      const cat = String(ln.category ?? "").toLowerCase();
      if (cat === "basic") s.basic += empAmt;
      else if (cat === "allowance") s.allowances += empAmt;
      sumsByEmp.set(ln.employee_id, s);
    }
    for (const ps of payslips) {
      const s = sumsByEmp.get(ps.employee_id);
      if (!s) continue;
      s.taxable += Number(ps.taxable_income ?? ps.gross_pay) || 0;
      s.payslipCount = (s.payslipCount ?? 0) + 1;
    }

    const resolveBoundColumnValue = (s: SourceContext["sums"], columnKey: string): number | undefined => {
      const binding = bindingsByColumn.get(columnKey);
      if (!binding) return undefined;
      const component = s.byComponent?.[binding.scheme_component_id] ?? { employee: 0, employer: 0 };
      const value = binding.side === "total"
        ? component.employee + component.employer
        : binding.side === "employer"
          ? component.employer
          : component.employee;
      return Number(value.toFixed(2));
    };
    const applyBoundColumns = (s: SourceContext["sums"]) => {
      if (!bindingsByColumn.size) return;
      for (const col of columns) {
        const value = resolveBoundColumnValue(s, col.key);
        if (value !== undefined) (s.byColumn ||= {})[col.key] = value;
      }
    };
    for (const s of sumsByEmp.values()) applyBoundColumns(s);

    const readColumnSource = (col: ColumnSpec, ctx: SourceContext): unknown => {
      if (ctx.sums.byColumn && Object.prototype.hasOwnProperty.call(ctx.sums.byColumn, col.key)) {
        return ctx.sums.byColumn[col.key];
      }
      return readSource(col.source, ctx);
    };
    const hasReportableAmount = (s: SourceContext["sums"]) => {
      if (s.employee !== 0 || s.employer !== 0) return true;
      return Object.values(s.byColumn ?? {}).some((value) => Number(value) !== 0);
    };


    // 5) Project rows per declarative columns
    const groupBy: string[] = Array.isArray(template.body?.group_by) ? template.body.group_by : ["employee_id"];
    const projected: Array<Record<string, unknown>> = [];
    if (groupBy.includes("employee_id")) {
      for (const eid of employeeIds) {
        const emp = empById.get(eid) ?? {};
        const sums = sumsByEmp.get(eid) ?? emptySums();
        if (!hasReportableAmount(sums)) continue; // skip empty rows
        const row: Record<string, unknown> = {};
        for (const col of columns) row[col.key] = readColumnSource(col, { employee: emp, sums });
        projected.push(row);
      }
    } else {
      // single aggregate row
      const sums = Array.from(sumsByEmp.values()).reduce((a, s) => {
        a.employee += s.employee;
        a.employer += s.employer;
        a.taxable += s.taxable;
        a.basic += s.basic;
        a.allowances += s.allowances;
        a.payslipCount = (a.payslipCount ?? 0) + (s.payslipCount ?? 0);
        for (const [code, r] of Object.entries(s.byRule)) {
          const cur = a.byRule[code] ?? { employee: 0, employer: 0 };
          cur.employee += r.employee;
          cur.employer += r.employer;
          a.byRule[code] = cur;
        }
        for (const [componentId, r] of Object.entries(s.byComponent ?? {})) {
          const cur = a.byComponent?.[componentId] ?? { employee: 0, employer: 0 };
          cur.employee += r.employee;
          cur.employer += r.employer;
          (a.byComponent ||= {})[componentId] = cur;
        }
        return a;
      }, emptySums());
      applyBoundColumns(sums);
      const row: Record<string, unknown> = {};
      for (const col of columns) row[col.key] = readColumnSource(col, { employee: {}, sums });
      projected.push(row);
    }

    // 6) Totals + reconciliation
    const totalsKeys: string[] = Array.isArray(template.body?.totals) ? template.body.totals : [];
    const totals: Record<string, number> = {};
    for (const k of totalsKeys) {
      totals[k] = projected.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    }

    // W6: Multi-rule reconciliation. `body.reconciliation` may be either:
    //   { rule_code, column_key? }                — legacy single-rule (still works)
    // OR
    //   [ { rule_code, column_key? }, ... ]       — one block per rule
    // Each entry compares the projected total of `column_key` (or the first
    // sum_employee_amount column) against payroll_liabilities.original_amount
    // for that specific rule_code in the period. Backward compatible.
    const recoRaw = template.body?.reconciliation;
    const recoSpecs: Array<{ rule_code: string; column_key?: string }> = Array.isArray(recoRaw)
      ? recoRaw
      : (recoRaw?.rule_code ? [recoRaw] : []);
    let reconciliation: any = null;
    if (recoSpecs.length) {
      const blocks: Array<{ rule_code: string; expected: number; actual: number; diff: number }> = [];
      for (const spec of recoSpecs) {
        const { data: liabs } = await admin
          .from("payroll_liabilities")
          .select("original_amount")
          .eq("organization_id", body.organization_id)
          .eq("business_id", body.business_id)
          .eq("rule_code", spec.rule_code)
          .lte("period_start", body.period_end)
          .gte("period_end", body.period_start);
        const liabTotal = (liabs ?? []).reduce((a: number, r: any) => a + (Number(r.original_amount) || 0), 0);
        const expected = Number(liabTotal.toFixed(2));
        const col = spec.column_key
          ? columns.find((c) => c.key === spec.column_key)
          : columns.find((c) => c.source === "sum_employee_amount");
        const projTotal = col
          ? projected.reduce((a, r) => a + (Number(r[col.key]) || 0), 0)
          : 0;
        const actual = Number(projTotal.toFixed(2));
        blocks.push({ rule_code: spec.rule_code, expected, actual, diff: Number((actual - expected).toFixed(2)) });
      }
      // Preserve legacy shape (single block) when only one rule
      reconciliation = blocks.length === 1 ? blocks[0] : { blocks };
    }

    const branding = await getOrganizationBranding(admin, body.organization_id, body.business_id);
    const orgCurrency = branding?.currencyCode ?? "";

    // 7) Render outputs
    const serial = makeSerial(template.code, body.period_end);
    // NOTE: The `documents` bucket RLS enforces `user_has_org_access(foldername[1])`,
    // so the organization_id MUST be the first path segment. Anything else fails
    // the signed-URL check with a misleading 400 "Object not found".
    const basePath = `${body.organization_id}/payroll/statutory-returns/${body.period_end.slice(0, 4)}/${template.code}/${serial}`;
    // Canonical artifact registry — pack-declared exports land here. The
    // legacy {csv,pdf,gov_file}_path columns were dropped in migration
    // 20260712 once every reader migrated to `artifacts`. Dispatch is now
    // driven exclusively by `template.outputs[]` (ADR 0060 / migration
    // 20260711232041) — no more `template.output` scalar branches.
    type Artifact = {
      format: string;
      path: string;
      mime: string;
      ext: string;
      size: number;
      role: "primary" | "human_readable" | "audit" | "portal";
      generated_at: string;
    };
    const artifacts: Artifact[] = [];
    const pushArtifact = (a: Omit<Artifact, "generated_at">) =>
      artifacts.push({ ...a, generated_at: new Date().toISOString() });

    // Resolve the pack-declared output list. Every template row now carries
    // a non-empty `outputs` array (backfilled 2026-07-12). We defensively
    // fall back to `[{format:'csv',role:'primary'}]` so any future INSERT
    // that forgets to set outputs still produces something audit-able,
    // rather than silently emitting zero files.
    const declaredOutputs: Array<{ format: string; role?: string; label?: string | null; filename?: string | null }> =
      Array.isArray((template as any).outputs) && (template as any).outputs.length
        ? ((template as any).outputs as any[])
        : [{ format: "csv", role: "primary" }];
    const declaredFormats = new Set(declaredOutputs.map((o) => String(o.format)));
    const wantCsv = declaredFormats.has("csv");
    const wantPdf = declaredFormats.has("pdf");
    const govFormat: "gov_csv" | "gov_xlsx" | "gov_xml" | null =
      declaredFormats.has("gov_xlsx") ? "gov_xlsx" :
      declaredFormats.has("gov_xml")  ? "gov_xml"  :
      declaredFormats.has("gov_csv")  ? "gov_csv"  : null;

    if (wantCsv) {
      const header = columns.map((c) => csvEscape(c.label ?? c.key)).join(",");
      const rowsCsv = projected.map((r) => columns.map((c) => csvEscape(r[c.key])).join(",")).join("\n");
      const totalsLine = totalsKeys.length
        ? "\n" + columns.map((c) => totalsKeys.includes(c.key) ? csvEscape((totals[c.key] ?? 0).toFixed(2)) : "").join(",")
        : "";
      const csv = header + "\n" + rowsCsv + totalsLine;
      const path = `${basePath}.csv`;
      const upload = await admin.storage
        .from(STORAGE_BUCKET)
        .upload(path, new Blob([csv], { type: "text/csv" }), { contentType: "text/csv", upsert: true });
      if (upload.error) {
        return businessError(
          500,
          "RETURN_STORAGE_WRITE_FAILED",
          "The return was calculated but the CSV artifact could not be saved.",
          "Retry generation. If this repeats, ask an administrator to check document storage access for statutory returns.",
          { template_code: body.template_code, period_start: body.period_start, period_end: body.period_end, detail: upload.error.message },
        );
      }
      const csvRole = (declaredOutputs.find((o) => o.format === "csv")?.role as Artifact["role"]) ?? "audit";
      pushArtifact({ format: "csv", path, mime: "text/csv", ext: "csv", size: csv.length, role: csvRole });
    }

    if (wantPdf) {
      // STATUTORY PAPER PIN — locked to A4 by issuing tax authority
      // (KRA, URA, TRA, etc.). Filing portals reject anything else.
      // Do NOT consult `document_print_policies` here; statutory
      // returns must remain bit-identical regardless of tenant prefs.
      assertStatutoryPaper("a4");
      let pdfBytes: Uint8Array;
      // v2-returns section renderer — same architecture as certificate
      // renderer; feature-flagged per template body so old packs keep
      // rendering through the legacy `generateReportPdf` path.
      if (isReturnTemplateV2(template as any)) {
        // Adapt the outer `reconciliation` block (already computed above)
        // into the renderer's single-rule shape. Multi-rule reconciliation
        // is summarised by its first block; publishers can add more
        // detail via a dedicated `reconciliation_block` section later.
        const first = reconciliation
          ? (Array.isArray((reconciliation as any).blocks)
              ? (reconciliation as any).blocks[0]
              : reconciliation)
          : null;
        const recoPayload = first
          ? {
              rule_code: String(first.rule_code ?? first.code ?? ""),
              expected: Number(first.expected ?? 0),
              actual: Number(first.actual ?? 0),
              delta: Number(first.delta ?? (Number(first.actual ?? 0) - Number(first.expected ?? 0))),
            }
          : null;
        pdfBytes = await renderReturnPdf(template as any, {
          employer: {
            name: branding?.name ?? "",
            tax_pin: (branding as any)?.tax_pin ?? null,
            address: (branding as any)?.address ?? null,
            tax_office: (branding as any)?.tax_office ?? null,
          },
          period_start: body.period_start,
          period_end: body.period_end,
          period_label: `${body.period_start} → ${body.period_end}`,
          currency: orgCurrency,
          rows: projected as any,
          totals,
          reconciliation: recoPayload,
          serial_number: template.code,
          generated_at: new Date().toISOString(),
        });
      } else {
        const pdfPayload: ReportPdfPayload = {
          title: template.display_name,
          subtitle: `Period ${body.period_start} → ${body.period_end}${template.authority_name ? ` • ${template.authority_name}` : ""}`,
          companyName: branding?.name ?? "",
          organization: branding ?? undefined,
          currency: orgCurrency,
          columns: columns.map((c) => ({
            key: c.key,
            header: c.label ?? c.key,
            align: c.source.startsWith("sum_") ? "right" : "left",
            format: c.source.startsWith("sum_") ? "money" : undefined,
          })),
          rows: projected as any,
          summaryRows: totalsKeys.map((k) => ({
            label: `Total ${k}`,
            value: `${orgCurrency ? orgCurrency + " " : ""}${(totals[k] ?? 0).toFixed(2)}`,
          })),
          footerNote: `${template.code} • ${body.period_start} → ${body.period_end}`,
        };
        pdfBytes = await generateReportPdf(pdfPayload);
      }
      const path = `${basePath}.pdf`;
      const upload = await admin.storage
        .from(STORAGE_BUCKET)
        .upload(path, new Blob([pdfBytes], { type: "application/pdf" }), {
          contentType: "application/pdf",
          upsert: true,
        });
        if (upload.error) {
          return businessError(
            500,
            "RETURN_STORAGE_WRITE_FAILED",
            "The return was calculated but the PDF artifact could not be saved.",
            "Retry generation. If this repeats, ask an administrator to check document storage access for statutory returns.",
            { template_code: body.template_code, period_start: body.period_start, period_end: body.period_end, detail: upload.error.message },
          );
        }
      const pdfRole = (declaredOutputs.find((o) => o.format === "pdf")?.role as Artifact["role"]) ?? "human_readable";
      pushArtifact({ format: "pdf", path, mime: "application/pdf", ext: "pdf", size: pdfBytes.byteLength, role: pdfRole });
    }

    // P1.2: Government-portal-import file (iTax bulk CSV, URA PAYE CSV, etc.)
    // Driven by `template.submission_format` and gated on the pack-declared
    // outputs. Country-agnostic — no branches.
    const subFmt = (template as any).submission_format as GovFileSubmissionFormat | null;
    const isGovOutput = govFormat !== null;
    if (subFmt || isGovOutput) {
      try {
        const columnKeyByLabel = new Map<string, string>();
        for (const col of columns) {
          columnKeyByLabel.set(String(col.label ?? col.key).toLowerCase(), col.key);
          columnKeyByLabel.set(String(col.key).toLowerCase(), col.key);
        }
        const renderSubFmt = subFmt && Array.isArray((subFmt as any).columns)
          ? {
              ...(subFmt as any),
              columns: ((subFmt as any).columns as any[]).map((col) => {
                const key = col?.header ? columnKeyByLabel.get(String(col.header).toLowerCase()) : null;
                return key && bindingsByColumn.has(key)
                  ? { ...col, source: `bound_column.${key}` }
                  : col;
              }),
            }
          : subFmt;
        const govRows = employeeIds
          .map((eid) => ({
            employee: empById.get(eid) ?? {},
            sums: sumsByEmp.get(eid) ?? emptySums(),
          }))
          .filter((r) => hasReportableAmount(r.sums));
        const out = await renderGovFile(renderSubFmt ?? { type: "gov_csv", columns: [] }, govRows);
        if (out) {
          const path = `${basePath}.${out.extension}`;
          const upload = await admin.storage
            .from(STORAGE_BUCKET)
            .upload(path, new Blob([out.bytes], { type: out.contentType }), {
              contentType: out.contentType,
              upsert: true,
            });
          if (upload.error) {
            return businessError(
              500,
              "RETURN_STORAGE_WRITE_FAILED",
              "The return was calculated but the government filing artifact could not be saved.",
              "Retry generation. If this repeats, ask an administrator to check document storage access for statutory returns.",
              { template_code: body.template_code, period_start: body.period_start, period_end: body.period_end, detail: upload.error.message },
            );
          }
          const emittedGovFormat =
            out.extension === "gov.xlsx" ? "gov_xlsx" :
            out.extension === "gov.xml"  ? "gov_xml"  : "gov_csv";
          const govRole = (declaredOutputs.find((o) => o.format === emittedGovFormat)?.role as Artifact["role"]) ?? "portal";
          pushArtifact({
            format: emittedGovFormat,
            path,
            mime: out.contentType,
            ext: out.extension,
            size: out.bytes.byteLength,
            role: govRole,
          });
        }
      } catch (e: any) {
        // Surface the pack-format error to the caller rather than silently
        // skipping — admins need to fix the pack template, not the data.
        if (isGovOutput) {
          return jsonResponse({ error: `gov format: ${e?.message ?? String(e)}` }, 400);
        }
        // submission_format was opportunistic — log but don't fail the run
        console.warn("gov file render failed (non-fatal):", e?.message ?? e);
      }
    }

    // 8) Idempotency + supersede — enforce the (business, template, period)
    // uniqueness contract at the app layer, backed by the partial unique
    // index `payroll_return_runs_active_slot_uidx`. When a caller sends
    // `regenerate=true` we mark the existing active run as `superseded`
    // through the state-machine RPC (which writes an audit + outbox event)
    // and continue with a fresh insert. When `regenerate` is falsy and an
    // active run already exists, we return it unchanged (idempotent GET).
    const { data: existing } = await admin
      .from("payroll_return_runs")
      .select("id, serial_number, artifacts, period_start, period_end, template_code, status, payload, reconciliation_status")
      .eq("business_id", body.business_id)
      .eq("template_code", template.code)
      .eq("period_start", body.period_start)
      .eq("period_end", body.period_end)
      .neq("status", "superseded")
      .maybeSingle();

    let priorRunId: string | null = null;
    if (existing) {
      if (!body.regenerate) {
        return jsonResponse({ run: existing, reconciliation, totals, reused: true });
      }
      const existingStatus = String((existing as any).status ?? "");
      if (["submitted_awaiting_ack"].includes(existingStatus)) {
        return businessError(
          409,
          "RETURN_STATE_NOT_REGENERABLE",
          "This return has already been submitted to the authority and cannot be superseded while it is awaiting acknowledgement.",
          "Record the authority acknowledgement or rejection first, then regenerate only if the filing outcome allows supersession.",
          { run_id: (existing as any).id, status: existingStatus, template_code: body.template_code },
        );
      }
      priorRunId = (existing as any).id;
      const { error: supErr } = await admin.rpc("payroll_return_transition", {
        _run_id: priorRunId,
        _to_status: "superseded",
        _reason: "regenerated",
        _payload: { reason: "regenerate" },
      });
      if (supErr) {
        return businessError(
          409,
          "RETURN_SUPERSEDE_FAILED",
          "The existing return could not be superseded, so a replacement was not created.",
          "Review the return's current filing state and regenerate only from a state that allows supersession.",
          { run_id: priorRunId, status: existingStatus, detail: supErr.message },
        );
      }
    }

    // Slice D — derive reconciliation_status from the reconciliation block.
    const tolerance = Number(template.body?.reconciliation_tolerance ?? 1.0);
    let reconciliationStatus: "unknown" | "ok" | "breach" | "not_applicable" = "not_applicable";
    let reconciliationBreach: any = null;
    if (reconciliation) {
      const blocks = Array.isArray((reconciliation as any).blocks)
        ? (reconciliation as any).blocks
        : [reconciliation];
      const breached = blocks.filter((b: any) => Math.abs(Number(b.diff) || 0) > tolerance);
      if (breached.length) {
        reconciliationStatus = "breach";
        reconciliationBreach = { tolerance, breached };
      } else {
        reconciliationStatus = "ok";
      }
    }

    const payload = {
      template_code: template.code,
      template_pack_id: template.pack_id,
      template_source: templateSource,
      template_version: packTemplate.updated_at,
      override_version: overrideVersion,
      period_start: body.period_start,
      period_end: body.period_end,
      generated_at: new Date().toISOString(),
      filters,
      columns,
      rows: projected,
      totals,
      reconciliation,
      reconciliation_status: reconciliationStatus,
      counts: {
        payslips: payslips.length,
        employees: employeeIds.length,
        lines: lines?.length ?? 0,
      },
    };

    // Deterministic idempotency key so a retried invocation with the same
    // amendment lineage collapses to a single row instead of racing the
    // unique index.
    const keyMaterial = `${template.code}:${body.period_start}:${body.period_end}:${body.business_id}:${priorRunId ?? "root"}`;
    const keyBytes = new TextEncoder().encode(keyMaterial);
    const keyBuf = await crypto.subtle.digest("SHA-256", keyBytes);
    const idempotency_key = Array.from(new Uint8Array(keyBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const { data: inserted, error: insErr } = await admin
      .from("payroll_return_runs")
      .insert({
        organization_id: body.organization_id,
        business_id: body.business_id,
        branch_id: body.branch_id ?? null,
        template_code: template.code,
        template_pack_id: template.pack_id,
        period_start: body.period_start,
        period_end: body.period_end,
        payload,
        artifacts,
        serial_number: serial,
        status: "generated",
        generated_by: userId,
        reconciliation_status: reconciliationStatus,
        reconciliation_breach: reconciliationBreach,
        amends_run_id: priorRunId,
        idempotency_key,
      })
      .select("id, serial_number, artifacts, period_start, period_end, template_code, status, payload, reconciliation_status")
      .single();
    if (insErr) {
      return businessError(
        500,
        "RETURN_INSERT_FAILED",
        "The return artifacts were created but the return run record could not be saved.",
        "Retry generation. If this repeats, ask an administrator to review statutory return run constraints and audit logs.",
        { template_code: body.template_code, period_start: body.period_start, period_end: body.period_end, detail: insErr.message },
      );
    }

    // Record the birth of the run in the transition audit so the outbox
    // fires `return.state_changed` for the new row too.
    await admin.from("pack_return_run_audit").insert({
      run_id: (inserted as any).id,
      organization_id: body.organization_id,
      business_id: body.business_id,
      from_status: null,
      to_status: "generated",
      actor_user_id: userId ?? null,
      reason: priorRunId ? "regenerated" : "generated",
      payload: { amends_run_id: priorRunId, idempotency_key },
    });



    // Slice D — emit blocking diagnostic for reconciliation breach so the
    // submission gate trigger refuses `submitted_awaiting_ack` until the
    // breach is resolved (regenerate) or explicitly overridden with a reason.
    if (reconciliationStatus === "breach") {
      await admin.from("payroll_return_diagnostics").upsert({
        run_id: (inserted as any).id,
        organization_id: body.organization_id,
        business_id: body.business_id,
        code: "RETURN_RECONCILIATION_BREACH",
        severity: "blocker",
        blocking: true,
        message: `Return totals disagree with payroll_liabilities by more than ${tolerance}`,
        details: reconciliationBreach,
      }, { onConflict: "run_id,code" });
    }

    // Audit trail (P2.1): record the generation event
    try {
      await admin.from("payroll_return_filing_events").insert({
        run_id: (inserted as any).id,
        organization_id: body.organization_id,
        business_id: body.business_id,
        event: "generated",
        actor_id: userId,
        payload: {
          template_code: template.code,
          serial_number: serial,
          has_gov_file: artifacts.some((a) => a.role === "portal" || /^gov_/.test(a.format)),
          reconciliation_status: reconciliationStatus,
        },
      });
    } catch (e) {
      console.warn("filing event log failed (non-fatal):", e);
    }

    return jsonResponse({ run: inserted, reconciliation, totals });
  } catch (e: any) {
    return jsonResponse({ error: e?.message ?? String(e) }, 500);
  }
});
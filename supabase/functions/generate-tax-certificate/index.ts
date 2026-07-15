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
import { buildMatrixRows, collectDerivedArgOffences, collectMatrixRuleCodes, matrixUsesCategoryAggregation, sumMatrixColumn } from "../_shared/certificateMatrix.ts";
import { type CertificateTemplateV3 } from "../_shared/certificate-engine/types.ts";
import { getOrganizationBranding } from "../_shared/branding/index.ts";
import { renderTemplateBody } from "../_shared/renderTemplateBody.ts";
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

function walkDocumentNodes(nodes: any[], visit: (node: any) => void): void {
  const walk = (n: any) => {
    if (!n || typeof n !== "object") return;
    visit(n);
    if (Array.isArray(n.children)) n.children.forEach(walk);
    if (Array.isArray(n.column_children)) {
      n.column_children.forEach((col: any) => Array.isArray(col) && col.forEach(walk));
    }
  };
  nodes.forEach(walk);
}

function matrixColumnKey(c: any): string {
  return String(c?.key ?? c?.bind_key ?? c?.id ?? "");
}

function isMonthColumn(c: any): boolean {
  const key = matrixColumnKey(c);
  return key === "month" || key === "month_index" || String(c?.format ?? "").toLowerCase() === "month_short";
}

function validateCanonicalSourceNode(params: {
  node: any;
  templateCode: string;
  templateSource: string;
  kind: "matrix" | "grid";
}): Response | null {
  const { node, templateCode, templateSource, kind } = params;
  const cols: any[] = Array.isArray(node.columns) ? node.columns : [];
  const dataCols = cols.filter((c) => matrixColumnKey(c) && !isMonthColumn(c));
  const explicitCodes: string[] = Array.isArray(node.rule_codes) ? node.rule_codes.map((x: any) => String(x)).filter(Boolean) : [];
  const sourceKeys: string[] = cols.map((c: any) => c?.source_key ? String(c.source_key) : "").filter(Boolean);
  const derivedKeys = new Set<string>(Array.isArray(node.derived_columns) ? node.derived_columns.map((d: any) => String(d?.key ?? "")) : []);

  if (dataCols.length > 0 && explicitCodes.length === 0 && sourceKeys.length === 0) {
    return businessError(
      422,
      "TEMPLATE_STRUCTURAL_INVALID",
      `Certificate template "${templateCode}" has a ${kind} with no rule-code bindings (source_key / rule_codes) and no derived columns; every data column would render as zero.`,
      `Republish the localization pack so the ${kind} declares \`rule_codes\` at the node level and/or \`source_key\` on each data column that maps to a canonical payroll rule.`,
      { template_code: templateCode, template_source: templateSource, contract: `${kind}.rule_codes`, reason_code: `${kind.toUpperCase()}_NO_RULE_CODES` },
    );
  }

  const unbound = dataCols
    .filter((c: any) => !c.source_key && !derivedKeys.has(matrixColumnKey(c)))
    .map((c: any) => matrixColumnKey(c));
  if (unbound.length > 0) {
    return businessError(
      422,
      "TEMPLATE_STRUCTURAL_INVALID",
      `Certificate template "${templateCode}" has ${kind} column(s) with no canonical binding: ${unbound.join(", ")}.`,
      "Bind each data column via `source_key` (canonical rule code) or a `derived_columns` entry keyed to the column. Statutory templates must never render unbound zeros.",
      { template_code: templateCode, template_source: templateSource, contract: `${kind}.columns`, reason_code: `${kind.toUpperCase()}_COLUMN_UNBOUND`, unbound_columns: unbound },
    );
  }

  // Every string arg in every derived_columns expression must resolve to a
  // real symbol (column key, earlier derived key, or a rule_code in the
  // matrix superset). Otherwise the column silently evaluates to 0 (see
  // monthlyMatrix.argValue). ADR-0061 addendum.
  const derivedOffences = collectDerivedArgOffences(node);
  if (derivedOffences.length > 0) {
    return businessError(
      422,
      "TEMPLATE_STRUCTURAL_INVALID",
      `Certificate template "${templateCode}" has ${kind} derived_columns referencing unresolved symbol(s): ${
        derivedOffences.map((o) => `${o.derived_key}[${o.arg}]`).join(", ")
      }.`,
      "Every string arg in derived_columns must be another column key, an earlier derived key, or a rule_code listed on the matrix. Republish the pack with the corrected references.",
      {
        template_code: templateCode,
        template_source: templateSource,
        contract: `${kind}.derived_columns`,
        reason_code: `${kind.toUpperCase()}_DERIVED_ARG_UNRESOLVED`,
        unresolved: derivedOffences,
      },
    );
  }

  return null;
}

function writeRowsAtPath(payload: Record<string, any>, path: string, rows: any[]): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) return;
  let cursor: any = payload;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cursor[parts[i]] !== "object" || cursor[parts[i]] == null) {
      cursor[parts[i]] = {};
    }
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = rows;
}

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

    // Structural refusal — v3 templates only.
    // Legacy v1/v2 renderers were retired; the DB trigger
    // `assert_certificate_template_body_valid` rejects any body with
    // schema_version < 3. We still validate the v3 shape here so the runtime
    // surfaces a clean TEMPLATE_STRUCTURAL_INVALID instead of exploding
    // inside the compiler on a malformed document tree.
    {
      if (!isV3EngineTemplate(template)) {
        return businessError(
          422,
          "TEMPLATE_STRUCTURAL_INVALID",
          `Certificate template "${template.code}" is not a v3 engine template. The pdf-lib v1/v2 renderers have been retired.`,
          "Republish the localization pack with this template authored as a v3 document AST (paper_format + page_master + document nodes).",
          { template_code: template.code, template_source: templateSource },
        );
      }
      const nodes: any[] = Array.isArray(template?.body?.document) ? template.body.document : [];
      const types = new Set<string>();
      // v4 documents nest data-bearing nodes inside section / columns
      // wrappers. Walk the tree so `grid` inside a `section` still counts
      // as a data-bearing node — otherwise every non-flat pack refuses.
      walkDocumentNodes(nodes, (n) => {
        if (n.type) types.add(String(n.type));
      });
      // v3: `matrix` / `table`. v4: `grid` (cell-level control, replaces matrix).
      const hasData = types.has("matrix") || types.has("table") || types.has("grid");
      if (nodes.length === 0 || !hasData) {
        try {
          await admin.from("payroll_diagnostics").insert({
            organization_id: body.organization_id,
            business_id: body.business_id,
            severity: "error",
            code: "TEMPLATE_STRUCTURAL_INVALID",
            message: `Certificate template "${template.code}" refused: v3 document missing a data-bearing node (matrix or table)`,
            details: {
              template_code: template.code,
              template_source: templateSource,
              pack_id: template.pack_id ?? null,
              contract: "document",
              nodes_present: Array.from(types),
            },
          });
        } catch { /* diagnostics best-effort */ }
        return businessError(
          422,
          "TEMPLATE_STRUCTURAL_INVALID",
          `Certificate template "${template.code}" cannot be rendered: its document has no data-bearing node (grid / matrix / table) to carry the payroll data.`,
          "Ask your platform administrator to publish a version of this template that includes a grid (v4) or matrix (v3) node bound to the resolved payload.",
          {
            template_code: template.code,
            template_source: templateSource,
            contract: "document",
            nodes_present: Array.from(types),
          },
        );
      }

      // Matrix-binding contract (country-agnostic). A v3 `matrix` node must
      // resolve to a non-empty rule-code set AND every non-derived data
      // column must be bound to a canonical source (rule_code via
      // `source_key`, membership in `rule_codes`, or a derived expression).
      //
      // Without this guard, a pack that ships a matrix stripped of
      // `source_key` / `rule_codes` / `derived_columns` (as happened with
      // KE P9A in migration 20260713001927) silently emits a zero-filled
      // column on a filed statutory document. Refuse loudly instead —
      // this is the class-level fix that prevents this defect from
      // recurring across every localization pack and future certificate.
      const matrixNodes: any[] = [];
      const gridNodes: any[] = [];
      walkDocumentNodes(nodes, (n) => {
        if (n.type === "matrix") matrixNodes.push(n);
        if (n.type === "grid") gridNodes.push(n);
      });
      for (const m of matrixNodes) {
        const invalid = validateCanonicalSourceNode({ node: m, templateCode: template.code, templateSource, kind: "matrix" });
        if (invalid) return invalid;
      }
      for (const g of gridNodes) {
        const invalid = validateCanonicalSourceNode({ node: g, templateCode: template.code, templateSource, kind: "grid" });
        if (invalid) return invalid;
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

        // v3 rule-code collection happens later, inside the matrix-node
        // walk (see `collectMatrixRuleCodes`). No pre-fetch here.
        let monthlyRows: MonthlyRow[] = [];


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

        // Render lazily and cache — one compile per template.
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
          const doc = Array.isArray((template.body as any).document) ? (template.body as any).document : [];
          const dataNodes: any[] = [];
          walkDocumentNodes(doc, (n) => {
            if (n?.type === "matrix" || n?.type === "grid") dataNodes.push(n);
          });
          for (const dataNode of dataNodes) {
            const codes = collectMatrixRuleCodes(dataNode);
            let v3Monthly: any[] = [];
            if (codes.length) {
              const { data: mm } = await admin.rpc("payroll_employee_monthly_breakdown", {
                p_year: body.fiscal_year,
                p_employee_id: emp.id,
                p_rule_codes: codes,
              });
              v3Monthly = (mm ?? []) as any[];
            }
            const matrixRows = buildMatrixRows(v3Monthly, dataNode);
            // Bind the rows at the template's rows_binding path (dot path).
            const bindingPath = dataNode.type === "grid"
              ? String(dataNode.data_rows?.bind ?? "grid.rows")
              : String(dataNode.rows_binding ?? "matrix.rows");
            writeRowsAtPath(enginePayload as any, bindingPath, matrixRows);
            // Summary totals the template binds (Col. K / Col. O).
            (enginePayload as any).totals = {
              ...(enginePayload as any).totals,
              chargeable_pay: sumMatrixColumn(matrixRows, "chargeable_pay") || sumMatrixColumn(matrixRows, "col_k"),
              paye: sumMatrixColumn(matrixRows, "paye_net") || sumMatrixColumn(matrixRows, "col_o"),
            };
          }
        }


        // Certificate Engine v3: the audited artifact is the compiled
        // HTML (CSS Paged Media). It is byte-identical to what the
        // publisher sees in the editor preview AND to what the tenant
        // materialises to a vector PDF client-side (paged.js + browser
        // print). This is the ONLY render path — the pdf-lib renderers
        // have been retired; "preview === output" holds by construction.
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
          if (decl.format === "pdf" || decl.format === "html") {
            if (!htmlBytes) htmlBytes = renderHtml();
            bytes = htmlBytes;
            ext = "html";
            // The bucket's allowed_mime_types whitelist does not include
            // text/html, so we store the compiled HTML audit artifact under
            // the closest allowed textual MIME (text/plain; utf-8). The
            // artifact record still carries the true ext ("html") so the
            // client renderer (paged.js) treats the body as HTML.
            mime = "text/plain; charset=utf-8";
            producedFormat = "html";
          } else {
            // xlsx and any other declared format have no v3 renderer yet.
            // (The pdf-lib-backed xlsx renderer was retired alongside the
            // certificate PDF renderer.) Record a diagnostic so publishers
            // see it and skip.
            try {
              await admin.from("payroll_diagnostics").insert({
                organization_id: body.organization_id,
                pack_id: template.pack_id ?? null,
                template_code: template.code,
                surface: "certificate",
                severity: "error",
                code: "CERT_OUTPUT_UNSUPPORTED",
                message: `Certificate output format '${decl.format}' has no v3 renderer.`,
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
              // v3-only renderer stack (pdf-lib retired).
              renderer: "v3-html",
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

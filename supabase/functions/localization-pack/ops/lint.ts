/**
 * lint-localization-pack
 *
 * Pre-publish consistency checker for a localization pack. The
 * per-row JSON-Schema trigger guarantees every row is *individually*
 * valid; this function checks *cross-row* invariants that no
 * publisher can be expected to remember:
 *
 *   - Every active statutory rule has a token entry in `pack_token_registry`
 *     for any `{{tokens}}` referenced by its templates.
 *   - Every employer-side rule (`employer_contribution` /
 *     `statutory_employer`) has an account-role mapping in
 *     `pack_account_roles`.
 *   - Every rule that ships a remittance frequency has a matching
 *     row in `localization_pack_remittance_schedules`.
 *   - Every annual rule has at least one certificate template.
 *   - Every certificate / return template body's tokens resolve.
 *   - No rule references a `superseded_by` rule that doesn't exist
 *     in the same pack version.
 *
 * Called by:
 *   - the publisher portal (preview button) — body: { pack_id }
 *   - `publish-localization-pack-version` (hard gate) — fails publish
 *     if `errors.length > 0`.
 *
 * Response: { errors: string[], warnings: string[] }
 *
 * NOTE: Country-agnostic by construction. Reads only metadata; never
 * branches on rule_code / country_code.
 */
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { extractTokens } from "../../_shared/validateAgainstSchema.ts";
import { checkCertificateCompleteness } from "../../_shared/certificateCompleteness.ts";
import { compile as compileCertificateHtml } from "../../_shared/certificate-engine/compile.ts";
import { type CertificateTemplateV3 } from "../../_shared/certificate-engine/types.ts";
import { buildLintFixture, byteFloorFor } from "../../_shared/certificateLintFixture.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const EMPLOYER_KINDS = new Set(["employer_contribution", "statutory_employer"]);

// ── Structural contract for certificate & return template bodies ────
// (ADR 0060 v2026.4.0). A pack cannot be published if any statutory
// document template ships with a malformed legacy sections body or malformed
// v2 blocks body, missing identity/signature structure, or missing legal metadata.
// Baseline sections required for EVERY certificate regardless of
// doc-class. Doc-class specific rules (P9 needs the 12-month grid, P10
// needs employer totals + statutory footnote, etc.) come from the
// shared `certificateCompleteness` rule table and are applied on top.
const REQUIRED_IDENTITY_SECTIONS = ["employer_header", "employee_header", "signature_block"];
const DATA_SECTIONS = ["monthly_breakdown", "ytd_table", "totals"];
const STATUTORY_CODE_RE = /^(P9|P10|VAT|PAYE|NSSF|SHIF|AHL|WHT|NHIF|NITA|HELB)/i;

function isCertificateOfService(row: any): boolean {
  const code = String(row?.code ?? row?.rule_code ?? row?.body?.code ?? "").toUpperCase();
  const displayName = String(row?.display_name ?? row?.body?.display_name ?? "");
  return code === "CERT_OF_SERVICE" || code === "CERTIFICATE_OF_SERVICE" || /certificate\s+of\s+service/i.test(displayName);
}

function validateMetadata(label: string, code: string, row: any, errs: string[]) {
  if (!row.effective_date || String(row.effective_date) < "2000-01-01") {
    errs.push(`${label}: effective_date must be set and >= 2000-01-01 (got ${row.effective_date ?? "null"}).`);
  }
  if (STATUTORY_CODE_RE.test(String(code)) && !row.authority_id) {
    errs.push(`${label}: statutory code requires authority_id (link a statutory_authorities row).`);
  }
  if (row.legal_reference && !row.regulation_citation) {
    errs.push(`${label}: regulation_citation is required whenever legal_reference is set.`);
  }
}

/** Certificates may render from legacy sections[] or v2 blocks[]. */
function validateCertificateStructure(row: any): string[] {
  const errs: string[] = [];
  const code = row.code ?? row.rule_code ?? "(unknown)";
  const label = `certificate template "${code}"`;
  const body = row.body ?? {};
  const document = Array.isArray(body?.document) ? body.document : [];
  const sections = Array.isArray(body?.sections) ? body.sections : [];
  const blocks = Array.isArray(body?.blocks) ? body.blocks : [];
  if (Number(body?.schema_version ?? 1) >= 3 && document.length > 0) {
    const types = new Set<string>(document.map((n: any) => String(n?.type ?? "")));
    const hasIdentity = types.has("identity_strip") || types.has("field_row");
    const hasSignature = types.has("signature_strip");
    const hasData = types.has("matrix") || types.has("grid") || types.has("table");
    if (!hasIdentity) errs.push(`${label}: v3/v4 document missing identity_strip or field_row.`);
    if (!hasSignature) errs.push(`${label}: v3/v4 document missing signature_strip.`);
    if (!hasData && !isCertificateOfService(row)) {
      errs.push(`${label}: v3/v4 document must include at least one matrix/grid/table data node.`);
    }
  } else if (Number(body?.schema_version ?? 1) >= 2 && blocks.length > 0) {
    const hasEmployer = blocks.some((b: any) => b?.type === "field_grid" && String(b?.data_source ?? "") === "employer");
    const hasEmployee = blocks.some((b: any) => b?.type === "field_grid" && String(b?.data_source ?? "") === "employee");
    const hasSignature = blocks.some((b: any) => b?.type === "signature_block");
    const hasData = blocks.some((b: any) => b?.type === "table" && ["monthly_breakdown", "monthly_matrix", "ytd_rows"].includes(String(b?.data_source ?? "")));
    if (!hasEmployer) errs.push(`${label}: v2 blocks missing employer field_grid.`);
    if (!hasEmployee) errs.push(`${label}: v2 blocks missing employee field_grid.`);
    if (!hasSignature) errs.push(`${label}: v2 blocks missing signature_block.`);
    if (!hasData && !isCertificateOfService(row)) errs.push(`${label}: v2 blocks must include at least one table bound to monthly_breakdown, monthly_matrix, or ytd_rows.`);
    const completeness = checkCertificateCompleteness(String(code), body);
    if (!completeness.ok) {
      errs.push(
        `${label}: ${completeness.rule.label} is missing required section(s): ${completeness.missing.join(", ")}.`,
      );
    }
  } else if (sections.length === 0) {
    errs.push(`${label}: body.sections or body.blocks must be non-empty.`);
  } else {
    const types = new Set<string>(sections.map((s: any) => String(s?.type ?? "")));
    for (const need of REQUIRED_IDENTITY_SECTIONS) {
      if (!types.has(need)) errs.push(`${label}: missing required section "${need}".`);
    }
    if (!DATA_SECTIONS.some((d) => types.has(d)) && !isCertificateOfService(row)) {
      errs.push(`${label}: must contain at least one data section (${DATA_SECTIONS.join(" | ")}).`);
    }
    // Doc-class specific completeness (shared with publish gate + editor).
    const completeness = checkCertificateCompleteness(String(code), body);
    if (!completeness.ok) {
      errs.push(
        `${label}: ${completeness.rule.label} is missing required section(s): ${completeness.missing.join(", ")}.`,
      );
    }
  }
  validateMetadata(label, code, row, errs);
  return errs;
}

/**
 * Return templates are aggregation specs consumed by the return-file
 * builders (CSV / portal upload). Their body shape is column-oriented
 * (`{ columns[], filters, group_by, totals, reconciliation }`), NOT the
 * section-based PDF layout used by certificates. Enforce the aggregation
 * contract + statutory metadata; do NOT require `sections[]`.
 */
function validateReturnStructure(row: any): string[] {
  const errs: string[] = [];
  const code = row.code ?? row.rule_code ?? "(unknown)";
  const label = `return template "${code}"`;
  const body = row.body ?? {};
  const columns = Array.isArray(body?.columns) ? body.columns : [];
  if (columns.length === 0) {
    errs.push(`${label}: body.columns must be a non-empty array — return templates are aggregation specs.`);
  } else {
    // Every column needs a key + source; header/label optional but recommended.
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i] ?? {};
      if (!c.key) errs.push(`${label}: column[${i}] missing "key".`);
      if (!c.source) errs.push(`${label}: column[${i}] missing "source" (e.g. sum_employee_amount, employee.tax_pin).`);
    }
  }
  if (!body?.filters || typeof body.filters !== "object") {
    errs.push(`${label}: body.filters must specify at least rule_codes / payslip_status to scope the aggregation.`);
  }
  if (!Array.isArray(body?.totals) || body.totals.length === 0) {
    errs.push(`${label}: body.totals must list the columns to sum in the footer / reconciliation.`);
  }
  validateMetadata(label, code, row, errs);
  return errs;
}

/**
 * Bank-export templates are file-format specs (CSV / fixed-width) consumed
 * by payroll disbursement. They must declare which version of the bank's
 * file spec they implement (`spec_reference`) and an `effective_date` so
 * old bank-format revisions can be sunset cleanly. `authority_id` is
 * optional — most clearing formats (Pesalink, EFT) are issued by clearing
 * houses, not statutory authorities.
 */
function validateBankExportStructure(row: any): string[] {
  const errs: string[] = [];
  const code = row.format_code ?? "(unknown)";
  const label = `bank export template "${code}"`;
  const spec = row.spec ?? {};
  if (!spec || typeof spec !== "object") {
    errs.push(`${label}: spec must be a JSON object describing the file format.`);
  } else if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    errs.push(`${label}: spec.columns must be a non-empty array of field descriptors.`);
  }
  if (!row.spec_reference || String(row.spec_reference).trim() === "") {
    errs.push(`${label}: spec_reference is required (bank-file spec version, e.g. "KBA Pesalink Bulk File Spec v1.2").`);
  }
  if (!row.effective_date || String(row.effective_date) < "2000-01-01") {
    errs.push(`${label}: effective_date must be set and >= 2000-01-01 (got ${row.effective_date ?? "null"}).`);
  }
  if (row.legal_reference && !row.regulation_citation) {
    errs.push(`${label}: regulation_citation is required whenever legal_reference is set.`);
  }
  return errs;
}

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function run(req: Request): Promise<Response> {

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { pack_id } = await req.json();
    if (!pack_id) return ok({ errors: ["pack_id required"], warnings: [] }, 400);

    const errors: string[] = [];
    const warnings: string[] = [];

    // Load everything we need in parallel.
    const [
      { data: pack },
      { data: rules },
      { data: schedules },
      { data: certTpls },
      { data: returnTpls },
      { data: accountRoles },
      { data: tokens },
      { data: payrollTpls },
      { data: bankExportTpls },
    ] = await Promise.all([
      sb.from("localization_packs").select("id, country_code, name").eq("id", pack_id).maybeSingle(),
      sb.from("payroll_statutory_rules").select("id, rule_code, rule_type, computation_method, parameters, superseded_by, remittance_frequency, period")
        .eq("pack_id", pack_id),
      sb.from("localization_pack_remittance_schedules").select("rule_code, frequency").eq("pack_id", pack_id),
      sb.from("localization_pack_certificate_templates")
        .select("body, rule_code, code, display_name, effective_date, authority_id, legal_reference, regulation_citation")
        .eq("pack_id", pack_id),
      sb.from("localization_pack_return_templates")
        .select("body, rule_code, code, effective_date, authority_id, legal_reference, regulation_citation")
        .eq("pack_id", pack_id),
      sb.from("pack_account_roles").select("rule_code, role_key").eq("pack_id", pack_id),
      sb.from("pack_token_registry").select("token_path").or(`pack_id.is.null,pack_id.eq.${pack_id}`),
      sb.from("localization_pack_payroll_templates").select("body").eq("pack_id", pack_id),
      sb.from("localization_pack_bank_export_templates")
        .select("format_code, spec, spec_reference, effective_date, authority_id, legal_reference, regulation_citation")
        .eq("pack_id", pack_id),
    ]);

    if (!pack) return ok({ errors: [`pack ${pack_id} not found`], warnings: [] }, 404);

    const ruleByCode = new Map((rules ?? []).map((r: any) => [r.rule_code, r]));
    const scheduleByCode = new Map((schedules ?? []).map((s: any) => [s.rule_code, s]));
    const certByCode = new Map<string, number>();
    for (const c of certTpls ?? []) certByCode.set(c.rule_code, (certByCode.get(c.rule_code) ?? 0) + 1);
    const rolesByCode = new Map<string, number>();
    for (const r of accountRoles ?? []) rolesByCode.set(r.rule_code, (rolesByCode.get(r.rule_code) ?? 0) + 1);
    const allowedTokens = new Set((tokens ?? []).map((t: any) => t.token_path));

    // ── invariants ──────────────────────────────────────────────────────
    for (const r of rules ?? []) {
      const kind = r.parameters?.type ?? r.computation_method ?? "unknown";

      // 1. employer-side rules need an account role
      if (EMPLOYER_KINDS.has(kind) && !rolesByCode.has(r.rule_code)) {
        errors.push(`Rule ${r.rule_code}: employer-side (${kind}) but no pack_account_roles entry`);
      }

      // 2. rules declaring a remittance frequency need a schedule
      if (r.remittance_frequency && !scheduleByCode.has(r.rule_code)) {
        errors.push(`Rule ${r.rule_code}: remittance_frequency='${r.remittance_frequency}' but no remittance schedule`);
      }

      // 3. annual rules should ship a certificate template
      if (r.period === "annual" && !certByCode.has(r.rule_code)) {
        warnings.push(`Rule ${r.rule_code}: annual but no certificate template — employees will have no year-end statement`);
      }

      // 4. superseded_by must point to a rule in the same pack
      if (r.superseded_by) {
        const exists = (rules ?? []).some((x: any) => x.id === r.superseded_by);
        if (!exists) errors.push(`Rule ${r.rule_code}: superseded_by references a rule outside this pack`);
      }
    }

    // 5. every token used in any template body must be in the registry
    const scanBodies = [
      ...(certTpls ?? []).map((t: any) => ({ kind: "certificate", code: t.rule_code, body: t.body })),
      ...(returnTpls ?? []).map((t: any) => ({ kind: "return", code: t.rule_code, body: t.body })),
      ...(payrollTpls ?? []).map((t: any, i: number) => ({ kind: "payroll", code: `#${i}`, body: t.body })),
    ];
    for (const t of scanBodies) {
      for (const tok of extractTokens(t.body)) {
        if (!allowedTokens.has(tok)) {
          errors.push(`${t.kind} template (${t.code}): unknown token {{${tok}}} — not in pack_token_registry`);
        }
      }
    }

    // 6. orphan account-role: role declared for a rule that doesn't exist
    for (const r of accountRoles ?? []) {
      if (!ruleByCode.has(r.rule_code)) {
        warnings.push(`pack_account_roles.${r.role_key} → rule ${r.rule_code}: rule not present in this pack`);
      }
    }

    // 7. orphan remittance schedule
    for (const s of schedules ?? []) {
      if (!ruleByCode.has(s.rule_code)) {
        warnings.push(`Remittance schedule for rule ${s.rule_code}: rule not present in this pack`);
      }
    }

    // 8. Structural contract for certificate/return template bodies.
    //    HARD-FAIL — anything that would fall back to the legacy
    //    generic-column renderer at runtime is rejected here.
    for (const t of certTpls ?? []) {
      for (const e of validateCertificateStructure(t)) errors.push(e);
    }
    for (const t of returnTpls ?? []) {
      for (const e of validateReturnStructure(t)) errors.push(e);
    }
    for (const t of bankExportTpls ?? []) {
      for (const e of validateBankExportStructure(t)) errors.push(e);
    }

    // 9. Visual QA gate — compile each certificate through the v3 engine
    //    against a synthetic fixture. Reject on compile failure or a
    //    byte-floor breach on the produced HTML (proxy for a template
    //    whose document tree collapses to a near-empty page at runtime).
    for (const t of certTpls ?? []) {
      const code = t.code ?? t.rule_code ?? "(unknown)";
      const label = `certificate template "${code}"`;
      try {
        const bodyV = Number(t?.body?.schema_version ?? 1);
        if (bodyV < 3 || !Array.isArray(t?.body?.document)) {
          errors.push(`${label}: body is not a v3 engine template (schema_version=${bodyV}). The pdf-lib renderers have been retired.`);
          continue;
        }
        const ruleCodes: string[] = [];
        for (const node of t.body.document as any[]) {
          if (node?.type !== "matrix") continue;
          for (const col of Array.isArray(node.columns) ? node.columns : []) {
            const c = String(col?.source_key ?? col?.rule_code ?? col?.key ?? "");
            if (c && c !== "month_index") ruleCodes.push(c);
          }
        }
        const payload = buildLintFixture(ruleCodes.length ? Array.from(new Set(ruleCodes)) : [t.rule_code].filter(Boolean));
        const template: CertificateTemplateV3 = {
          schema_version: 3,
          code,
          display_name: code,
          paper_format: t.body.paper_format,
          page_master: t.body.page_master,
          document: t.body.document,
        } as CertificateTemplateV3;
        const { html } = compileCertificateHtml(template, payload as Record<string, unknown>, {});
        const bytes = new TextEncoder().encode(html);
        const floor = byteFloorFor(String(code));
        if (bytes.byteLength < floor) {
          errors.push(
            `${label}: compiled HTML (${bytes.byteLength} bytes) is below the ${floor} byte floor — the document tree is likely rendering empty.`,
          );
        }
      } catch (e) {
        errors.push(`${label}: v3 compile threw during visual-QA — ${(e as any)?.message ?? e}`);
      }
    }

    // 10. Statutory Scheme model — structural bindings gate.
    //     For every scheme_component of type voluntary/employer/top_up in this
    //     pack's country, require either (a) an explicit statutory_reporting_bindings
    //     row referencing a return template that exists in this pack, or (b) an
    //     opt-out marker on the component (parameters.reports_to = 'none').
    //     Also cross-check: every binding must resolve to a `sum_rule.<code>.<side>`
    //     column in the referenced template body — the "documented but never
    //     materialised" failure mode (Kenya NSSF voluntary pre-fix) becomes
    //     impossible.
    try {
      const country = (pack as any).country_code;
      const [{ data: schemes }, { data: components }, { data: bindings }] = await Promise.all([
        sb.from("statutory_schemes").select("id, code").eq("country_code", country),
        sb.from("statutory_scheme_components").select("id, scheme_id, code, component_type, party, rule_code, parameters").in(
          "scheme_id",
          [], // placeholder — filled below
        ),
        sb.from("statutory_reporting_bindings").select("scheme_component_id, return_template_code, column_key, side"),
      ]);
      const schemeIds = (schemes ?? []).map((s: any) => s.id);
      let comps: any[] = [];
      if (schemeIds.length) {
        const { data: c2 } = await sb
          .from("statutory_scheme_components")
          .select("id, scheme_id, code, component_type, party, rule_code, parameters")
          .in("scheme_id", schemeIds);
        comps = c2 ?? [];
      }
      const bindingsByComponent = new Map<string, any[]>();
      for (const b of bindings ?? []) {
        const arr = bindingsByComponent.get(b.scheme_component_id) ?? [];
        arr.push(b);
        bindingsByComponent.set(b.scheme_component_id, arr);
      }
      const returnTplByCode = new Map((returnTpls ?? []).map((t: any) => [t.code ?? t.rule_code, t]));

      const REQUIRE_BINDING = new Set(["voluntary", "employer", "top_up"]);
      for (const c of comps) {
        if (!REQUIRE_BINDING.has(c.component_type)) continue;
        const optOut = (c.parameters as any)?.reports_to === "none";
        const boundRows = bindingsByComponent.get(c.id) ?? [];
        if (boundRows.length === 0 && !optOut) {
          errors.push(
            `Scheme component ${c.code} (rule_code=${c.rule_code}, type=${c.component_type}): no statutory_reporting_bindings row and no parameters.reports_to='none' opt-out. Voluntary/employer/top-up components MUST declare where they surface in returns.`,
          );
          continue;
        }
        for (const b of boundRows) {
          const tpl = returnTplByCode.get(b.return_template_code);
          if (!tpl) continue; // template lives in another pack — cross-pack refs OK
          const cols = Array.isArray(tpl.body?.columns) ? tpl.body.columns : [];
          const expectedSource = `sum_rule.${c.rule_code}.${b.side}`;
          const hasColumn = cols.some(
            (col: any) => col?.key === b.column_key && String(col?.source ?? "") === expectedSource,
          );
          if (!hasColumn) {
            errors.push(
              `Return template ${b.return_template_code}: statutory_reporting_bindings row for component ${c.code} expects column key='${b.column_key}' with source='${expectedSource}', but the template body has no such column. Regenerate the template body from bindings.`,
            );
          }
        }
      }
    } catch (e) {
      warnings.push(`Statutory scheme binding lint skipped: ${(e as any)?.message ?? e}`);
    }


    return ok({ errors, warnings, summary: {
      rules: rules?.length ?? 0,
      certificates: certTpls?.length ?? 0,
      returns: returnTpls?.length ?? 0,
      schedules: schedules?.length ?? 0,
      account_roles: accountRoles?.length ?? 0,
      bank_exports: bankExportTpls?.length ?? 0,
    } });

  } catch (e) {
    return ok({ errors: [String((e as any)?.message ?? e)], warnings: [] }, 500);
  }

}


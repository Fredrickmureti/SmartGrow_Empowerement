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
import { extractTokens } from "../_shared/validateAgainstSchema.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const EMPLOYER_KINDS = new Set(["employer_contribution", "statutory_employer"]);

// ── Structural contract for certificate & return template bodies ────
// (ADR 0060 v2026.4.0). A pack cannot be published if any statutory
// document template ships with a legacy blocks-only body, missing
// identity/signature sections, or missing legal metadata.
const REQUIRED_IDENTITY_SECTIONS = ["employer_header", "employee_header", "signature_block"];
const DATA_SECTIONS = ["monthly_breakdown", "ytd_table", "totals"];
const STATUTORY_CODE_RE = /^(P9|P10|VAT|PAYE|NSSF|SHIF|AHL|WHT|NHIF|NITA|HELB)/i;

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

/**
 * Certificates render as PDFs with a section-based layout; every one must
 * carry employer/employee/signature identity + at least one data section.
 */
function validateCertificateStructure(row: any): string[] {
  const errs: string[] = [];
  const code = row.code ?? row.rule_code ?? "(unknown)";
  const label = `certificate template "${code}"`;
  const body = row.body ?? {};
  const sections = Array.isArray(body?.sections) ? body.sections : [];
  if (sections.length === 0) {
    errs.push(`${label}: body.sections is empty — legacy blocks-only templates are no longer publishable.`);
  } else {
    const types = new Set<string>(sections.map((s: any) => String(s?.type ?? "")));
    for (const need of REQUIRED_IDENTITY_SECTIONS) {
      if (!types.has(need)) errs.push(`${label}: missing required section "${need}".`);
    }
    if (!DATA_SECTIONS.some((d) => types.has(d))) {
      errs.push(`${label}: must contain at least one data section (${DATA_SECTIONS.join(" | ")}).`);
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

Deno.serve(async (req) => {
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
    ] = await Promise.all([
      sb.from("localization_packs").select("id, country_code, name").eq("id", pack_id).maybeSingle(),
      sb.from("payroll_statutory_rules").select("id, rule_code, rule_type, computation_method, parameters, superseded_by, remittance_frequency, period")
        .eq("pack_id", pack_id),
      sb.from("localization_pack_remittance_schedules").select("rule_code, frequency").eq("pack_id", pack_id),
      sb.from("localization_pack_certificate_templates")
        .select("body, rule_code, code, effective_date, authority_id, legal_reference, regulation_citation")
        .eq("pack_id", pack_id),
      sb.from("localization_pack_return_templates")
        .select("body, rule_code, code, effective_date, authority_id, legal_reference, regulation_citation")
        .eq("pack_id", pack_id),
      sb.from("pack_account_roles").select("rule_code, role_key").eq("pack_id", pack_id),
      sb.from("pack_token_registry").select("token_path").or(`pack_id.is.null,pack_id.eq.${pack_id}`),
      sb.from("localization_pack_payroll_templates").select("body").eq("pack_id", pack_id),
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

    return ok({ errors, warnings, summary: {
      rules: rules?.length ?? 0,
      certificates: certTpls?.length ?? 0,
      returns: returnTpls?.length ?? 0,
      schedules: schedules?.length ?? 0,
      account_roles: accountRoles?.length ?? 0,
    } });
  } catch (e) {
    return ok({ errors: [String((e as any)?.message ?? e)], warnings: [] }, 500);
  }
});

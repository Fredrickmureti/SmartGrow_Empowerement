// @ts-nocheck — Deno runtime
/**
 * certificateCompleteness — per-document-class statutory completeness
 * rules for `localization_pack_certificate_templates.body.sections[]`.
 *
 * The `certificate_template_v2` JSON Schema whitelists which section
 * TYPES may appear in a body. It does NOT enforce that a given document
 * class (KE P9, KE Certificate of Service, NG PAYE cert, etc.) actually
 * carries the sections a payroll officer expects.
 *
 * Doc-class rules live here (not in the DB schema) so publishers can
 * evolve them per country without a schema migration. This module is
 * the single source of truth — mirrored to the browser via
 * `src/features/localization/lib/certificateCompleteness.ts` for the
 * editor's inline hints; keep the two files in sync.
 *
 * Used by:
 *   - publish-localization-pack-version (hard-fail publish)
 *   - CertificateTemplateEditor (inline "Add missing section" prompt)
 *   - lint-localization-pack (future visual QA gate)
 */

export type DocClass =
  | "p9"
  | "p10"
  | "cert_of_service"
  | "annual_tax_certificate"
  | "monthly_tax_certificate"
  | "generic";

export interface CompletenessRule {
  docClass: DocClass;
  label: string;
  requiredSections: readonly string[];
  /** Optional short human sentence shown next to a missing-section chip. */
  rationale?: string;
}

/**
 * Ordered from most specific to least specific. First matching pattern
 * wins. Pattern is tested against the lowercased template_code.
 */
const RULES: Array<{ match: RegExp; rule: CompletenessRule }> = [
  {
    match: /(^|[_-])p9($|[_-])/i,
    rule: {
      docClass: "p9",
      label: "Annual PAYE certificate (P9-class)",
      requiredSections: [
        "employer_header",
        "employee_header",
        "fiscal_period_band",
        "monthly_breakdown",
        "totals",
        "signature_block",
        "statutory_footnote",
      ],
      rationale: "P9-class certificates must identify employer + employee, show the 12-month PAYE grid, YTD totals, a signature area, and cite the enabling tax statute.",
    },
  },
  {
    match: /(^|[_-])p10($|[_-])/i,
    rule: {
      docClass: "p10",
      label: "Employer monthly PAYE return (P10-class)",
      requiredSections: [
        "employer_header",
        "fiscal_period_band",
        "totals",
        "signature_block",
        "statutory_footnote",
      ],
      rationale: "P10-class returns must carry employer identity, the reporting period, employer totals, a signatory, and the statutory citation.",
    },
  },
  {
    match: /cert.*service|service.*cert/i,
    rule: {
      docClass: "cert_of_service",
      label: "Certificate of Service",
      requiredSections: [
        "employer_header",
        "employee_header",
        "fiscal_period_band",
        "signature_block",
      ],
      rationale: "A Certificate of Service must identify employer + employee, state the period of service, and be signed.",
    },
  },
  {
    match: /annual.*cert|cert.*annual|tax.*year.*cert/i,
    rule: {
      docClass: "annual_tax_certificate",
      label: "Annual tax certificate",
      requiredSections: [
        "employer_header",
        "employee_header",
        "fiscal_period_band",
        "totals",
        "signature_block",
        "statutory_footnote",
      ],
    },
  },
  {
    match: /monthly.*cert|cert.*monthly/i,
    rule: {
      docClass: "monthly_tax_certificate",
      label: "Monthly tax certificate",
      requiredSections: [
        "employer_header",
        "employee_header",
        "fiscal_period_band",
        "totals",
        "signature_block",
      ],
    },
  },
];

const GENERIC_RULE: CompletenessRule = {
  docClass: "generic",
  label: "Statutory document",
  requiredSections: ["employer_header", "employee_header", "signature_block"],
  rationale: "Every statutory document must identify the employer, the subject, and carry a signatory.",
};

/** Resolve the applicable rule for a template code. Never returns null. */
export function resolveCompletenessRule(templateCode: string): CompletenessRule {
  const code = String(templateCode ?? "").trim();
  if (!code) return GENERIC_RULE;
  for (const { match, rule } of RULES) if (match.test(code)) return rule;
  return GENERIC_RULE;
}

export interface CompletenessResult {
  rule: CompletenessRule;
  missing: string[];
  ok: boolean;
}

/**
 * Check a certificate body's `sections[]` against the doc-class rule.
 * `body` may be any shape — this function is defensive so callers on
 * both the server (publish gate) and client (editor) can use it without
 * pre-validating.
 */
export function checkCertificateCompleteness(
  templateCode: string,
  body: unknown,
): CompletenessResult {
  const rule = resolveCompletenessRule(templateCode);
  const isV2Blocks = Number((body as any)?.schema_version ?? 1) >= 2 && Array.isArray((body as any)?.blocks);
  const sections = Array.isArray((body as any)?.sections) ? (body as any).sections : [];
  const present = new Set<string>(
    sections.map((s: any) => String(s?.type ?? "").trim()).filter(Boolean),
  );
  if (isV2Blocks) {
    for (const b of (body as any).blocks) {
      const type = String(b?.type ?? "").trim();
      if (type === "field_grid" && String(b?.data_source ?? "") === "employer") present.add("employer_header");
      if (type === "field_grid" && String(b?.data_source ?? "") === "employee") present.add("employee_header");
      if (type === "table" && ["monthly_breakdown", "monthly_matrix"].includes(String(b?.data_source ?? ""))) present.add("monthly_breakdown");
      if (type === "table" && String(b?.data_source ?? "") === "ytd_rows") present.add("ytd_table");
      if (type === "notes") present.add("statutory_footnote");
      if (type === "signature_block") present.add("signature_block");
    }
    if (present.has("monthly_breakdown") || present.has("ytd_table")) present.add("totals");
  }
  const missing = rule.requiredSections.filter((t) => !present.has(t));
  return { rule, missing, ok: missing.length === 0 };
}
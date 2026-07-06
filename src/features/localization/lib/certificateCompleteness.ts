/**
 * certificateCompleteness — browser mirror of the canonical rule table
 * in `supabase/functions/_shared/certificateCompleteness.ts`.
 *
 * Kept as a separate file (rather than shared through a workspace
 * package) because Vite cannot import from `supabase/functions/`. Keep
 * the two files in sync; the server copy is authoritative for
 * publish-gate decisions, the browser copy powers the editor's inline
 * "missing section" hints so publishers see the same rules before they
 * click Save.
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
  rationale?: string;
}

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
      rationale:
        "P9-class certificates must identify employer + employee, show the 12-month PAYE grid, YTD totals, a signature area, and cite the enabling tax statute.",
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
      rationale:
        "P10-class returns must carry employer identity, the reporting period, employer totals, a signatory, and the statutory citation.",
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
      rationale:
        "A Certificate of Service must identify employer + employee, state the period of service, and be signed.",
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
  rationale:
    "Every statutory document must identify the employer, the subject, and carry a signatory.",
};

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

export function checkCertificateCompleteness(
  templateCode: string,
  body: unknown,
): CompletenessResult {
  const rule = resolveCompletenessRule(templateCode);
  const sections = Array.isArray((body as any)?.sections)
    ? (body as any).sections
    : [];
  const present = new Set<string>(
    sections
      .map((s: any) => String(s?.type ?? "").trim())
      .filter(Boolean),
  );
  const missing = rule.requiredSections.filter((t) => !present.has(t));
  return { rule, missing, ok: missing.length === 0 };
}
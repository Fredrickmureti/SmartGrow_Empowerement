/**
 * statutorySnippets — publisher-facing library of canonical statutory
 * wording for footnotes and declaration blocks.
 *
 * These are legal fragments that publishers routinely copy verbatim from
 * the tax authority (e.g. the KRA P9A footer note or the cessation-of-
 * service declaration). Exposing them as a picker prevents drift,
 * paraphrasing, and typos in regulated language.
 *
 * Country-agnostic shape: keyed by `country || doc_class`. Additional
 * countries plug in without editor code changes.
 *
 * Kept static (not DB-backed) on purpose — the wording is authored by
 * the platform team and versioned in git alongside renderer changes,
 * exactly like the section vocabulary. A future migration to a
 * `pack_statutory_snippets` table (per-pack overrides) is straightforward
 * and does not change this interface.
 */
export interface StatutorySnippet {
  id: string;
  title: string;
  applies_to: ReadonlyArray<string>; // template_code prefixes ("P9", "P10", "cert_of_service")
  body: string;
}

export const STATUTORY_SNIPPETS: ReadonlyArray<StatutorySnippet> = [
  {
    id: "ke_p9_declaration",
    title: "KE · P9A employer declaration",
    applies_to: ["P9"],
    body:
      "I certify that the information given above is a true record of the emoluments " +
      "paid and tax deducted from the employee named. Issued under Section 37 of the " +
      "Income Tax Act, CAP 470.",
  },
  {
    id: "ke_p10_notice",
    title: "KE · P10 monthly return notice",
    applies_to: ["P10"],
    body:
      "This return summarises PAYE, NSSF, SHIF and Affordable Housing Levy deducted " +
      "for the month stated. Submitted under Section 37 of the Income Tax Act and the " +
      "regulations governing the respective statutory bodies.",
  },
  {
    id: "ke_cert_of_service",
    title: "KE · Certificate of Service declaration",
    applies_to: ["cert_of_service", "certificate_of_service"],
    body:
      "This certificate is issued in accordance with Section 51 of the Employment Act, " +
      "2007. It confirms the period, position and salary of the named employee as held " +
      "in the employer's records at the date of issue.",
  },
];

export function snippetsFor(templateCode: string): ReadonlyArray<StatutorySnippet> {
  const code = String(templateCode ?? "").toLowerCase();
  return STATUTORY_SNIPPETS.filter((s) =>
    s.applies_to.some((prefix) => code.startsWith(prefix.toLowerCase())),
  );
}

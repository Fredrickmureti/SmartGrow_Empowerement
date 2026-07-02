/**
 * Architecture guard test — fails CI if any document- or accounting-rendering
 * surface reads identity fields directly from `currentOrg`. All such reads
 * MUST come from `useDocumentBranding(record.business_id)` or `currentBusiness`.
 *
 * Org-level identity is intentionally limited to tenant chrome (sidebar,
 * portal layout, profile chip, settings page). The directories below are
 * the modules that emit customer-facing documents, run accounting logic,
 * or render legal-entity-specific content.
 *
 * The ALLOWLIST below contains files that are *legitimate* readers of
 * org-level chrome (logo in the sidebar, settings page editing the org
 * itself, fallback when no business is selected). Do not expand it without
 * justifying why the file is chrome rather than a document/accounting
 * surface.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep, posix } from "node:path";

const FORBIDDEN = /currentOrg\s*\?\.\s*(logo_url|legal_name|tax_id|registration_number|invoice_prefix|estimate_prefix|bill_prefix|credit_note_prefix|address|city|state|postal_code|country|base_currency|email|phone|website)\b|currentOrg\s*\.\s*(logo_url|legal_name|tax_id|registration_number|invoice_prefix|estimate_prefix|bill_prefix|credit_note_prefix|address|city|state|postal_code|country|base_currency|email|phone|website)\b/;

const SCOPES = [
  "src/components/invoices",
  "src/components/bills",
  "src/components/estimates",
  "src/components/sales",
  "src/components/purchases",
  "src/components/payments",
  "src/components/pos",
  "src/components/reports",
  "src/components/finance",
  "src/components/banking",
  "src/components/migration",
  "src/components/settings",
  "src/hooks",
  "src/pages",
];

// Legitimate org-chrome readers. These files render the *tenant* shell
// (sidebar logo, settings page editing the org, profile chip) — not
// customer-facing documents or accounting content. Adding a file here
// requires a justification comment.
const ALLOWLIST = new Set<string>(
  [
    // Sidebar / shell chrome — org logo for the tenant workspace
    "src/components/layout/AppSidebar.tsx",
    "src/components/layout/AppAwareSidebar.tsx",
    // Settings page edits the org record itself — must read it directly
    "src/pages/Settings.tsx",
    "src/pages/UserProfilePage.tsx",
    "src/pages/settings/UserProfilePage.tsx",
    // Tax-compliance fallback when no business is selected — never used in documents
    "src/hooks/useTaxCompliance.ts",
  ].map((p) => p.split("/").join(sep)),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

describe("architecture: document/accounting modules must not read identity from currentOrg", () => {
  for (const scope of SCOPES) {
    it(`${scope} contains no forbidden currentOrg identity reads`, () => {
      const files = walk(scope);
      const offenders: string[] = [];
      for (const f of files) {
        if (ALLOWLIST.has(f)) continue;
        const src = readFileSync(f, "utf8");
        if (FORBIDDEN.test(src)) offenders.push(toPosix(f));
      }
      expect(
        offenders,
        `Document/accounting modules must read identity via useDocumentBranding(business_id) or currentBusiness, not currentOrg. Offenders:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});

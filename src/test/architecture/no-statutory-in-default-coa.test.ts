import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Architecture guard — Phase E of the COA zero-trust audit.
 *
 * The global `default_chart_of_accounts` template MUST stay country-neutral.
 * Statutory / country-specific accounts (NHIF, SHIF, PAYE, NSSF, GST, VAT
 * registration codes, etc.) belong in opt-in localization packs only.
 *
 * This test scans every migration file and fails if a NEW insert into
 * `default_chart_of_accounts` mentions a known statutory keyword. The Phase A
 * purge migration is allowlisted because it intentionally references those
 * keywords while removing them.
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

const STATUTORY_KEYWORDS = [
  "NHIF",
  "SHIF",
  "PAYE",
  "NSSF",
  "KRA",
  "WHT",
  "EPF",
  "ESI",
  "GST Payable",
  "VAT Registration",
  "BIR",
  "SARS",
  "URA",
  "TRA",
  "SDL",
  "WCF",
  "ESIC",
  "Provident Fund",
  "PF Payable",
  "Housing Levy",
  "UIF",
  "Skills Levy",
  "Gratuity Payable",
];

// Migrations that are allowed to mention statutory keywords because they
// are explicitly purging / repairing them, not seeding them.
const ALLOWLIST = new Set<string>([
  "20260121114629_1cbef1fe-4829-49e4-9d60-33196d60106f.sql", // Original CoA template — statutory rows DELETED by Phase A purge; live DB CHECK constraint enforces neutrality from now on
  "20260428175148_06ab9cb1-bd33-4fc4-b291-308bd0848fb8.sql", // Phase A purge
  "20260428175344_3a3e6fc5-003e-4782-a2ec-9d2e2aefd427.sql", // Phase B lifecycle
  "20260428181019_5c8f8cb4-db00-45fe-96d1-e1325d85103f.sql", // R1–R4 hardening (regex/CHECK references statutory keywords intentionally)
  "20260525162011_4bb69506-f459-40cb-ab95-a22349a0995d.sql", // Account 6150 description text only mentions generic statutory categories ("housing levy" / "training levy") — no statutory-specific account row inserted
]);

describe("default_chart_of_accounts is country-neutral", () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

  for (const file of files) {
    if (ALLOWLIST.has(file)) continue;

    it(`migration ${file} does not seed statutory accounts into default_chart_of_accounts`, () => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");

      // Only inspect statements that INSERT into the global default template.
      const insertBlocks = sql.match(
        /insert\s+into\s+(public\.)?default_chart_of_accounts[\s\S]*?;/gi,
      );
      if (!insertBlocks) return;

      for (const block of insertBlocks) {
        for (const kw of STATUTORY_KEYWORDS) {
          const re = new RegExp(`\\b${kw}\\b`, "i");
          expect(
            re.test(block),
            `${file} inserts statutory keyword "${kw}" into default_chart_of_accounts. ` +
              `Move it to a localization pack (localization_pack_chart_of_accounts).`,
          ).toBe(false);
        }
      }
    });
  }
});

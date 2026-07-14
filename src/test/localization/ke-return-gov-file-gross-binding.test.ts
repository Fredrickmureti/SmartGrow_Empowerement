/**
 * ADR-0062 (Submission format parity) — static guard.
 *
 * Ensures no future migration seeds/updates a return template whose
 * `submission_format.columns[]` binds a gross-labelled header
 * (GROSS PAY / GROSS EMOLUMENTS / GROSS EARNINGS / GROSS_PAY / etc.)
 * to `sum_taxable_amount`. This is the exact defect that let NSSF_RET
 * file taxable_income under a "GROSS PAY" header for six months
 * because the earlier ADR-0062 rebind only touched `body.columns`.
 *
 * The runtime contract of `sum_gross_amount` is pinned by
 * `return-source-resolver-gross.test.ts`. The parallel guard for
 * `body.columns` lives in `ke-return-gross-binding.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const MIGRATIONS_DIR = resolve(__dirname, "../../../supabase/migrations");

// Historical seed migrations whose submission_format shipped the
// defect and were repointed at install time via a data update.
// Do not edit; migration files are immutable.
const ALLOW_LIST = new Set<string>([
  // Add historical seed files here if a future audit uncovers a
  // pre-fix submission_format gross→taxable binding.
]);

// Matches JSON objects of shape { "header": "...", "source": "..." }
// or { "source": "...", "header": "..." } in either order.
const HEADER_FIRST =
  /\{\s*"header"\s*:\s*"([^"]+)"[^}]*?"source"\s*:\s*"([^"]+)"[^}]*\}/g;
const SOURCE_FIRST =
  /\{\s*"source"\s*:\s*"([^"]+)"[^}]*?"header"\s*:\s*"([^"]+)"[^}]*\}/g;

interface Offender {
  file: string;
  header: string;
  source: string;
}

function isGrossHeader(h: string): boolean {
  const n = h.toLowerCase().replace(/[^a-z]+/g, "");
  return n.includes("gross");
}

function scan(): Offender[] {
  const offenders: Offender[] = [];
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  for (const f of files) {
    if (ALLOW_LIST.has(f)) continue;
    const body = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    // Only consider files that actually touch submission_format —
    // avoids matching unrelated JSON in comments/other columns.
    if (!/submission_format/i.test(body)) continue;

    for (const re of [HEADER_FIRST, SOURCE_FIRST]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        const [header, source] =
          re === HEADER_FIRST ? [m[1], m[2]] : [m[2], m[1]];
        if (isGrossHeader(header) && source === "sum_taxable_amount") {
          offenders.push({ file: f, header, source });
        }
      }
    }
  }
  return offenders;
}

describe("ADR-0062 — submission_format gross-column canonical binding", () => {
  it("no migration binds a gross-labelled submission_format column to sum_taxable_amount", () => {
    const offenders = scan();
    expect(
      offenders,
      offenders.length
        ? `Found ${offenders.length} submission_format gross→taxable binding(s):\n` +
            offenders.map((o) => `  ${o.file}: "${o.header}" → ${o.source}`).join("\n")
        : "",
    ).toHaveLength(0);
  });
});

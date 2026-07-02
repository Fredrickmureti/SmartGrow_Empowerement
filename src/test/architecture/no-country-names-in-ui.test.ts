/**
 * Architecture guard — country-agnostic HR & Payroll UI
 *
 * Country names (Kenya, Uganda, …) must NOT appear as user-visible strings
 * in HR or Payroll components. The platform is country-agnostic: any
 * country-flavoured copy must come from localization packs (JSON seeds,
 * pack templates), never hardcoded React text.
 *
 * Allowed:
 *   - comments referencing a country for design-doc context
 *   - localization seed fixtures under `localization/seeds/`
 *   - this guard file itself
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const COUNTRIES = [
  "Kenya", "Uganda", "Tanzania", "Rwanda", "Nigeria", "South Africa",
  "Germany", "France", "Netherlands", "Brazil", "India", "Australia",
  "Egypt", "Ghana",
  // "UK" / "USA" / "Canada" intentionally omitted — too many false positives
  // (e.g. "UK" inside variable names, "Canada" inside other words). Add them
  // back behind a stricter regex if needed.
];
const PATTERN = COUNTRIES.join("|");

const ALLOWLIST: RegExp[] = [
  /^localization\//,
  /^src\/test\/architecture\/no-country-names-in-ui\.test\.ts$/,
];

describe("hr/payroll UI country-agnostic guard", () => {
  it("no hardcoded country names in HR or Payroll UI strings", () => {
    const candidates = execSync(
      `rg --files-with-matches '\\b(${PATTERN})\\b' src/pages/hr src/components/payroll src/components/hr || true`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((p) => !ALLOWLIST.some((re) => re.test(p)));

    // Re-scan each file with JS comments stripped so design-doc references
    // in comments don't trip the guard.
    const offenders: string[] = [];
    for (const file of candidates) {
      const src = execSync(`cat ${file}`, { encoding: "utf8" });
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
      const re = new RegExp(`\\b(${PATTERN})\\b`);
      if (re.test(stripped)) offenders.push(file);
    }

    expect(offenders, `Country names found in HR/Payroll UI:\n${offenders.join("\n")}`).toEqual([]);
  });
});
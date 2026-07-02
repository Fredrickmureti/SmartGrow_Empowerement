/**
 * Architecture guard (H1) — bank disbursement export must remain
 * country-neutral. Country-rail tokens (pesalink, bacs, ach, sepa, eft)
 * must NOT appear hardcoded in `src/lib/payroll/`; all formats are
 * resolved at runtime from `localization_pack_bank_export_templates`.
 *
 * If you're adding a new country's bank file, add a row to that table
 * (in a migration), do NOT name it in source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../lib/payroll");
const FORBIDDEN = /\b(pesalink|bacs|sepa|eft|ach)\b/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("no-country-named-bank-export", () => {
  it("src/lib/payroll has no hardcoded bank-rail names", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const text = readFileSync(file, "utf8");
      // Strip block + line comments before scanning — doc comments are fine.
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (FORBIDDEN.test(stripped)) {
        offenders.push(path.relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
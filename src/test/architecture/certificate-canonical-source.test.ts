/**
 * ADR-0060 invariant: statutory certificates (P9, Certificate of Service, etc.)
 * MUST derive figures from the canonical YTD projection
 * (`payroll_employee_ytd` / `payroll_employee_ytd_rollup`) — never from raw
 * `payslip_lines`. Re-summing payslip lines in a certificate path silently
 * drifts from the payroll engine's official YTD numbers and defeats the
 * single-writer contract established for statutory documents.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOTS = [
  "supabase/functions/generate-tax-certificate",
  "supabase/functions/_shared/certificateSections.ts",
  "supabase/functions/_shared/certificateSourceResolver.ts",
];

function walk(p: string): string[] {
  const abs = resolve(process.cwd(), p);
  let st;
  try { st = statSync(abs); } catch { return []; }
  if (st.isFile()) return [abs];
  const out: string[] = [];
  for (const e of readdirSync(abs)) out.push(...walk(join(p, e)));
  return out;
}

describe("certificate-canonical-source", () => {
  it("certificate generation paths never read from payslip_lines", () => {
    const files = ROOTS.flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/payslip_lines/.test(src)) offenders.push(f);
    }
    expect(
      offenders,
      `Certificates must read YTD figures via payroll_employee_ytd_rollup, ` +
        `not by re-summing payslip_lines. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("payroll_employee_ytd_rollup is called only via certificateSourceResolver", () => {
    const files = walk("supabase/functions/generate-tax-certificate").filter(
      (f) => /\.(ts|tsx)$/.test(f),
    );
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (/payroll_employee_ytd_rollup/.test(src)) offenders.push(f);
    }
    expect(
      offenders,
      `Only certificateSourceResolver may call payroll_employee_ytd_rollup. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

/**
 * Architecture guard — a payslip line's category bucket is owned by exactly
 * two files (Deno + browser mirrors of `payslipClassifier`). Any other file
 * that hand-rolls a `Set` containing `"statutory_employee"` is re-inventing
 * payslip bucketing and is the class of bug that caused the PAY-0065
 * legal-order regression (renderer had a private `DEDUCTION_CATS` that
 * omitted `post_tax_deduction`, so a 7,000 KES garnishment silently
 * vanished from the PDF while still living in the header total).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

const ROOTS = [
  path.resolve(__dirname, "../../.."), // repo root — walks src + supabase/functions
];
const ALLOW = new Set<string>([
  path.resolve(__dirname, "../../../supabase/functions/_shared/payslipClassifier.ts"),
  path.resolve(__dirname, "../../lib/payroll/payslipClassifier.ts"),
  __filename,
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === ".tanstack" || name === ".wrangler" || name.startsWith(".venv")) continue;
    const full = path.join(dir, name);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("single payslip classifier", () => {
  it("no file outside the two canonical classifiers declares a Set of payslip category strings", () => {
    const files: string[] = [];
    for (const root of ROOTS) walk(root, files);
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOW.has(f)) continue;
      // Skip build/generated files.
      if (f.includes("/routeTree.gen") || f.endsWith(".d.ts")) continue;
      const src = readFileSync(f, "utf8");
      // Signature: a `new Set([...])` (or Set-like array literal) mentioning
      // the canonical marker category. The marker is deliberately narrow
      // so unrelated code using the string in comments/queries doesn't trip.
      if (/new\s+Set\s*\(\s*\[[^\]]*["']statutory_employee["'][^\]]*\]\s*\)/s.test(src)) {
        offenders.push(path.relative(process.cwd(), f));
      }
    }
    expect(
      offenders,
      `Payslip category bucketing must go through classifyPayslipLine from \`_shared/payslipClassifier.ts\` (or its browser mirror). Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
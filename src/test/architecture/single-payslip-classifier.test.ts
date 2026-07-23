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
      // Signature: a `new Set([...])` mentioning the canonical deduction
      // marker. We skip the enum whitelist Set (VALID_PAYSLIP_LINE_CATEGORIES
      // in compute-payroll) — it lists every legal category by design and
      // is not a bucketing decision. A bucketing set typically contains
      // `"loan_repayment"` alongside `"statutory_employee"` and does NOT
      // include the informational categories `"subtotal"` / `"net"` /
      // `"relief"` that the whitelist has to allow.
      const setLiteralRe = /new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)/g;
      for (const m of src.matchAll(setLiteralRe)) {
        const body = m[1];
        if (!/"statutory_employee"/.test(body)) continue;
        if (!/"loan_repayment"/.test(body)) continue;
        if (/"subtotal"|"net"|"relief"/.test(body)) continue; // enum whitelist, not a bucket
        offenders.push(path.relative(process.cwd(), f));
        break;
      }
    }
    expect(
      offenders,
      `Payslip category bucketing must go through classifyPayslipLine from \`_shared/payslipClassifier.ts\` (or its browser mirror). Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
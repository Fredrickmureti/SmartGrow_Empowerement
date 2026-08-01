/**
 * Architecture guard: the enterprise fiscal pipeline (edge functions +
 * `_shared` libs) must not reference KRA/eTIMS anywhere except in the
 * pack-registered Kenya adapter and the fiscal-compliance saga.
 *
 * This is the load-bearing architectural boundary: any other edge function
 * touching KRA is a country-agnosticism regression.
 *
 * Frontend Kenya UI (POS receipt block, workspace, settings) is intentionally
 * NOT policed here — it is Kenya-tenant-gated by installed pack detection at
 * the route level. See src/pages/FiscalComplianceWorkspace.tsx for the gate.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const NEEDLE = /\bkra\b|\betims\b/i;

// Only these edge-function paths may reference KRA/eTIMS.
const ALLOWED_PATTERNS: RegExp[] = [
  /supabase\/functions\/_shared\/etims\//,
  /supabase\/functions\/etims[-_]/,
  /supabase\/functions\/fiscal-compliance-saga\//,
  // Pre-existing shared libs with Kenya references in comments or field names
  // only. Ratcheted to prevent NEW leaks; refactor separately.
  /supabase\/functions\/_shared\/escpos\/builder_test\.ts$/,
  /supabase\/functions\/_shared\/govFileWriter\.ts$/,
  /supabase\/functions\/_shared\/pos\/fiscalBlock\.ts$/,
  /supabase\/functions\/_shared\/pos\/resolveReceiptTitle\.ts$/,
  /supabase\/functions\/_shared\/receipt\/theme\.ts$/,
  /supabase\/functions\/_shared\/xlsxWriter\.ts$/,
  /supabase\/functions\/_shared\/xmlWriter\.ts$/,
  /supabase\/functions\/_shared\/__tests__\//,
  /supabase\/functions\/_shared\/entitlementCheck\.ts$/,
  /supabase\/functions\/_shared\/escpos\/(blocks|builder)\.ts$/,
  /supabase\/functions\/generate-document\//,
  /supabase\/functions\/_shared\/payslip\//,
  /supabase\/functions\/generate-statutory-return\//,
];

const SCAN_DIRS = ["supabase/functions"];
const IGNORE = new Set(["node_modules", ".git", "dist", "build", "coverage"]);

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    if (IGNORE.has(e)) continue;
    const full = path.join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(e)) acc.push(full);
  }
  return acc;
}

describe("architecture: enterprise fiscal pipeline is country-agnostic", () => {
  it("no KRA/eTIMS references in edge functions outside the Kenya adapter and fiscal saga", () => {
    const leaks: Array<{ file: string; line: number; text: string }> = [];
    for (const d of SCAN_DIRS) {
      const files = walk(path.join(ROOT, d));
      for (const f of files) {
        const rel = path.relative(ROOT, f).replace(/\\/g, "/");
        if (ALLOWED_PATTERNS.some(p => p.test(rel))) continue;
        let content = "";
        try { content = readFileSync(f, "utf8"); } catch { continue; }
        if (!NEEDLE.test(content)) continue;
        content.split("\n").forEach((line, i) => {
          if (NEEDLE.test(line)) leaks.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160) });
        });
      }
    }
    if (leaks.length > 0) {
      const preview = leaks.slice(0, 20).map(l => `  ${l.file}:${l.line}  ${l.text}`).join("\n");
      throw new Error(
        `KRA/eTIMS references leaked into ${leaks.length} edge-function location(s) outside the Kenya adapter:\n${preview}\n\n` +
          "Move them into supabase/functions/_shared/etims/** or supabase/functions/fiscal-compliance-saga/**.",
      );
    }
    expect(leaks).toHaveLength(0);
  });

  it("fiscal-compliance-saga does not hard-code any provider URL", () => {
    const sagaFile = path.join(ROOT, "supabase/functions/fiscal-compliance-saga/index.ts");
    const content = readFileSync(sagaFile, "utf8");
    // Saga must NOT hard-code KRA URLs — those come from the pack via the adapter.
    const forbidden = /etims-api(-sbx)?\.kra\.go\.ke/i;
    expect(forbidden.test(content)).toBe(false);
  });

  it("adapter builds all URLs from the pack row (no KRA URL literals in adapter.ts)", () => {
    const adapterFile = path.join(ROOT, "supabase/functions/_shared/etims/adapter.ts");
    const content = readFileSync(adapterFile, "utf8");
    const kraUrlLiteral = /https?:\/\/[^"'\s]*kra\.go\.ke/i;
    expect(kraUrlLiteral.test(content)).toBe(false);
  });
});

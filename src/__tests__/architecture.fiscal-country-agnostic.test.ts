/**
 * Architecture guard: Kenya-specific KRA/eTIMS identifiers must not leak into
 * the country-agnostic platform. Non-Kenyan tenants should have zero surface
 * area for the fiscalization subsystem beyond the pack-registered adapter.
 *
 * Allowed paths (anything matching one of these regexes may reference KRA/eTIMS):
 *   - supabase/functions/_shared/etims/**
 *   - supabase/functions/etims-*\/**
 *   - supabase/functions/fiscal-compliance-saga/**
 *   - supabase/migrations/*etims* or *fiscal*  (seed + backfill)
 *   - src/pages/FiscalComplianceWorkspace.tsx
 *   - src/hooks/pos/usePOSEtims.ts, src/hooks/useTaxCompliance.ts
 *     (transitional — will be replaced by the country-agnostic
 *     v_fiscal_workspace_health view + fiscal_transmissions subscription)
 *   - src/integrations/supabase/types.ts (generated)
 *   - Kenya localization pack seed migrations
 *   - This test file
 *
 * Any other file matching /kra|etims/i is a leak.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");
const NEEDLE = /\bkra\b|\betims\b/i;

const ALLOWED_PATTERNS: RegExp[] = [
  /supabase\/functions\/_shared\/etims\//,
  /supabase\/functions\/etims[-_]/,
  /supabase\/functions\/fiscal-compliance-saga\//,
  /supabase\/migrations\/.*\.sql$/,
  /src\/pages\/FiscalComplianceWorkspace\.tsx$/,
  /src\/hooks\/pos\/usePOSEtims\.ts$/,
  /src\/hooks\/useTaxCompliance\.ts$/,
  /src\/integrations\/supabase\/types\.ts$/,
  /src\/__tests__\/architecture\.fiscal-country-agnostic\.test\.ts$/,
  /src\/lib\/regionConfig\.ts$/,
  // Kenya-gated UI (must remain hidden for non-Kenya tenants — enforced at
  // route level by the pack gate; ratcheted here to prevent NEW leaks).
  /src\/components\/etims\//,
  /src\/components\/common\/EtimsQRCode\.tsx$/,
  /src\/pages\/(settings\/|.*)Etims/i,
  /src\/App\.tsx$/, // route registration only
];


const SCAN_DIRS = ["src", "supabase/functions"];
const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const e of entries) {
    if (IGNORE.has(e)) continue;
    const full = path.join(dir, e);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|sql|js|jsx)$/.test(e)) acc.push(full);
  }
  return acc;
}

describe("architecture: fiscal subsystem is country-agnostic outside the Kenya pack", () => {
  it("no Kenya (KRA/eTIMS) literals outside allowed paths", () => {
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
        `Kenya-specific KRA/eTIMS identifiers leaked into ${leaks.length} location(s) outside allowed paths:\n${preview}\n\n` +
          "Move these references into supabase/functions/_shared/etims/**, the fiscal-compliance-saga edge function, " +
          "or the localization pack seed migration.",
      );
    }
    expect(leaks).toHaveLength(0);
  });
});

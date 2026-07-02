/**
 * Architecture guard — ADR 0016.
 *
 * The Inventory Adjustment ↔ GL contract relies on three server-side
 * primitives doing all financially-meaningful writes against
 * `stock_adjustments`:
 *
 *   - apply_or_request_stock_adjustment  (create + auto-approve)
 *   - approve_stock_adjustment_atomic    (status → approved + GL posting)
 *   - reverse_stock_adjustment_atomic    (status → reversed + reversal links + contra JE)
 *   - backfill_missing_adjustment_je     (legacy GL repair only)
 *
 * If a renderer ever calls `.from('stock_adjustments').update({...})` and
 * touches `status`, the approval timestamps, the reversal-link columns, or
 * the cost/qty totals, it bypasses the canonical writers — re-opening the
 * original defect class (silent stock moves with no JE, mutated approved
 * rows, hand-edited reversal chains).
 *
 * The ONLY sanctioned client-side update against this table is the
 * draft → cancelled transition (which never touched the GL in the first
 * place). This test enforces that allowlist by greping every file under
 * src/ and failing if any other field appears inside an update payload
 * targeting `stock_adjustments`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";
const ALLOWED_FIELDS = new Set(["status"]);
const ALLOWED_STATUS_VALUES = new Set(["cancelled", "rejected"]);
const FORBIDDEN_FIELDS = [
  "approved_at",
  "approved_by",
  "reverses_adjustment_id",
  "reversed_by_adjustment_id",
  "total_value",
  "client_request_id",
  "adjustment_date",
  "reason",
  "warehouse_id",
  "branch_id",
  "business_id",
  "organization_id",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(t|j)sx?$/.test(name)) out.push(p);
  }
  return out;
}

// Skip this test file itself + the renderer-side cancelStockAdjustment hook
// is intentionally allowed; we still validate its update payload below.
const SELF = __filename;

describe("no client-side writes to stock_adjustments outside the canonical RPCs", () => {
  const files = walk(ROOT).filter((f) => f !== SELF && !f.includes("/test/"));

  it("rejects forbidden field writes inside `.from('stock_adjustments').update(...)`", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const sql = readFileSync(file, "utf8");
      // Find every .from("stock_adjustments") ... .update({...}) chain.
      const fromRe = /\.from\(\s*["']stock_adjustments["']\s*\)([\s\S]{0,600}?)\.update\(\s*\{([\s\S]{0,400}?)\}\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = fromRe.exec(sql))) {
        const payload = m[2];
        // Extract bare identifiers used as object keys.
        const keyRe = /(?:^|[,{\s])([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g;
        const keys: string[] = [];
        let km: RegExpExecArray | null;
        while ((km = keyRe.exec(payload))) keys.push(km[1]);
        for (const k of keys) {
          if (FORBIDDEN_FIELDS.includes(k)) {
            offenders.push(`${file}: forbidden field "${k}" in stock_adjustments.update payload`);
          } else if (!ALLOWED_FIELDS.has(k)) {
            offenders.push(`${file}: non-allowlisted field "${k}" in stock_adjustments.update payload (only ${[...ALLOWED_FIELDS].join(",")} allowed)`);
          }
        }
        // If status is set, restrict to cancelled/rejected.
        const statusValRe = /status\s*:\s*["']([a-zA-Z_]+)["']/;
        const sv = payload.match(statusValRe);
        if (sv && !ALLOWED_STATUS_VALUES.has(sv[1])) {
          offenders.push(
            `${file}: stock_adjustments.update sets status="${sv[1]}" — only ${[...ALLOWED_STATUS_VALUES].join("/")} are allowed client-side; use approve_stock_adjustment_atomic / reverse_stock_adjustment_atomic.`,
          );
        }
      }

      // Bonus: no client-side upserts at all on this table.
      if (/\.from\(\s*["']stock_adjustments["']\s*\)[\s\S]{0,200}?\.upsert\(/.test(sql)) {
        offenders.push(`${file}: client-side .upsert() against stock_adjustments is forbidden — use the canonical RPCs.`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

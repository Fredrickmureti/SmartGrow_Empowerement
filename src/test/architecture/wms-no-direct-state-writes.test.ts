/**
 * Architecture guard (Phase 2.0 §2).
 *
 * WMS aggregate rows (`wms_tasks`, `wms_license_plates`,
 * `wms_receiving_sessions`, `wms_return_orders`, `wms_exceptions`) MUST
 * only have their FSM columns (`state`, `status`) mutated via the guarded
 * `wms_transition_*` / `wms_resolve_exception` RPCs. Direct `.update({
 * state: … })` from page or feature code bypasses row_version optimistic
 * locking, FSM edge validation, and the `business_event_outbox` emit —
 * every one of which is load-bearing per ADR 0101.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOTS = [
  path.resolve(__dirname, "../../pages/warehouse"),
  path.resolve(__dirname, "../../apps/warehouse"),
  path.resolve(__dirname, "../../features/warehouse"),
];

const AGGREGATES = [
  "wms_tasks",
  "wms_license_plates",
  "wms_receiving_sessions",
  "wms_return_orders",
  "wms_exceptions",
];

// Files intentionally allowed to touch these aggregates outside the RPC path
// (e.g. inserts of brand-new rows in `state: 'available'` from create dialogs).
// State/status mutations remain forbidden everywhere.
const ALLOW_INSERT_ONLY = new Set<string>([]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx"))
      out.push(p);
  }
  return out;
}

describe("WMS aggregates: no direct state/status writes outside FSM RPCs", () => {
  for (const table of AGGREGATES) {
    it(`no direct .update({ state|status }) on ${table}`, () => {
      const offenders: string[] = [];
      for (const root of ROOTS) {
        let files: string[] = [];
        try { files = walk(root); } catch { continue; }
        for (const f of files) {
          if (ALLOW_INSERT_ONLY.has(f)) continue;
          const src = readFileSync(f, "utf8");
          // Look for `.from("<table>") … .update(` with a `state:` or
          // `status:` key in the same statement. Kept intentionally simple
          // and conservative — false positives are surfaced as regressions.
          const fromRe = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`);
          if (!fromRe.test(src)) continue;
          // For every occurrence of `.from(table)`, scan the following ~600
          // chars for `.update({ … state|status: … })`.
          let idx = 0;
          while (true) {
            const m = fromRe.exec(src.slice(idx));
            if (!m) break;
            const start = idx + m.index;
            const window = src.slice(start, start + 800);
            if (/\.update\s*\(\s*\{[^}]*\b(state|status)\s*:/m.test(window)) {
              offenders.push(`${f}: writes ${table}.state|status directly`);
            }
            idx = start + m[0].length;
          }
        }
      }
      expect(offenders, offenders.join("\n") || "no offenders").toEqual([]);
    });
  }
});

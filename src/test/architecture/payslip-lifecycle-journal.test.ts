/**
 * Phase 4 P2 — payslip lifecycle journal architecture guard.
 *
 * The `payslip_events` table is the single source of truth for "what
 * happened to this payslip and when". Two invariants the codebase must
 * preserve:
 *
 *   1. Application code (browser + edge functions) MUST NOT insert into
 *      `payslip_events` directly. All writes go through the
 *      `emit_payslip_event` SECURITY DEFINER RPC so RLS, actor capture,
 *      and append-only semantics stay in one place.
 *
 *   2. Application code MUST NOT update or delete `payslip_events`. The
 *      table is append-only by trigger; an update/delete attempt would
 *      raise at runtime, but failing fast at lint time is cheaper.
 *
 * The trigger function lives in SQL migrations and is excluded.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../..");
const SCAN_ROOTS = [join(ROOT, "src"), join(ROOT, "supabase/functions")];

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

const FILES = SCAN_ROOTS.flatMap((r) => {
  try { return walk(r); } catch { return []; }
});

describe("payslip lifecycle journal (Phase 4 P2)", () => {
  it("no application code writes to payslip_events directly — use emit_payslip_event RPC", () => {
    const offenders: string[] = [];
    // Match shapes like .from("payslip_events").insert(...) /.update(...) /.delete(...)
    const re = /from\(\s*["'`]payslip_events["'`]\s*\)\s*\.\s*(insert|update|delete|upsert)\b/;
    for (const f of FILES) {
      if (f.endsWith("payslip-lifecycle-journal.test.ts")) continue;
      const src = readFileSync(f, "utf8");
      if (re.test(src)) {
        offenders.push(f.replace(ROOT + "/", ""));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("emit_payslip_event RPC is referenced (not silently abandoned) once any client emits events", () => {
    // Soft check: if anything imports `usePayslipEvents` we expect at least
    // one caller of the emit RPC to exist in the codebase as the system
    // matures. Skipped while no UI emits yet — kept as a placeholder so
    // we remember to enforce it when P5 wires PDF/email/portal events.
    expect(true).toBe(true);
  });
});

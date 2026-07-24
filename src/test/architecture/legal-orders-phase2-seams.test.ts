/**
 * ADR-0093 Phase 2 — Legal Order lifecycle & engine seams are pinned.
 *
 * The Legal Orders subsystem MUST have exactly one FSM writer and one
 * calculation engine. If either seam grows a sibling, this test fails
 * and the reviewer must consciously extend the invariants below.
 *
 *   FSM seam .......... `garnishment_transition` RPC
 *   Engine seam ....... `_shared/garnishment-engine.ts` (computeGarnishments)
 *   Payroll consumer .. `supabase/functions/compute-payroll/index.ts`
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const repo = process.cwd();
const read = (p: string) => readFileSync(join(repo, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(repo, dir))) {
    const rel = `${dir}/${name}`;
    const abs = join(repo, rel);
    try {
      const s = statSync(abs);
      if (s.isDirectory()) walk(rel, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
    } catch {
      /* ignore */
    }
  }
  return out;
}

describe("Legal Orders — Phase 2 lifecycle & engine seams", () => {
  it("FSM: only garnishment_transition mutates legal_orders_records.status from app code", () => {
    const files = walk("src");
    const offenders: string[] = [];
    for (const f of files) {
      if (f.includes("/test/") || f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
      const src = read(f);
      // Direct status writes are forbidden. Only the RPC may flip status.
      if (/legal_orders_records[\s\S]{0,200}\.update\(\s*\{[^}]*status\s*:/.test(src)) {
        offenders.push(f);
      }
    }
    expect(
      offenders,
      "Direct status writes bypass the FSM. Route through supabase.rpc('garnishment_transition', …).",
    ).toEqual([]);
  });

  it("Engine: computeGarnishments is defined in exactly one module", () => {
    const roots = ["src", "supabase/functions"];
    const defs: string[] = [];
    for (const r of roots) {
      for (const f of walk(r)) {
        if (/computeGarnishments\s*[<(]/.test(read(f)) && /export\s+function\s+computeGarnishments/.test(read(f))) {
          defs.push(f);
        }
      }
    }
    expect(defs, "computeGarnishments must live in exactly one canonical module").toEqual([
      "supabase/functions/_shared/garnishment-engine.ts",
    ]);
  });

  it("Engine: compute-payroll is the sole payroll caller of the engine", () => {
    const callers: string[] = [];
    for (const r of ["src", "supabase/functions"]) {
      for (const f of walk(r)) {
        if (f.endsWith("/garnishment-engine.ts")) continue;
        if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
        const src = read(f);
        if (/from\s+["'][^"']*_shared\/garnishment-engine(\.ts)?["']/.test(src)) {
          callers.push(f);
        }
      }
    }
    expect(callers.sort()).toEqual(["supabase/functions/compute-payroll/index.ts"]);
  });

  it("FSM RPC covers the full legal-order lifecycle", () => {
    // Latest canonical migration for garnishment_transition.
    const src = read(
      "supabase/migrations/20260723104544_2742c170-317e-47cf-9e6a-d25508dffa84.sql",
    );
    for (const action of [
      "submit",
      "approve",
      "reject",
      "activate",
      "suspend",
      "resume",
      "mark_satisfied",
      "release",
      "expire",
      "terminate_unsatisfied",
    ]) {
      expect(src, `garnishment_transition must handle action '${action}'`).toContain(
        `p_action = '${action}'`,
      );
    }
  });
});

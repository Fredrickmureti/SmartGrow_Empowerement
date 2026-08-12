/**
 * Phase 7c ratchet — vendor credit writers refuse a closed fiscal period.
 *
 * Every vendor-credit writer that moves money or the ledger (issue/post,
 * apply, unapply, reverse, reversal-intent resolution) must call the canonical
 * period guard `public.is_period_open`. The guard is present in all of them
 * today; this test keeps it there, because a writer that loses the guard fails
 * silently — it posts into a closed period and only surfaces at audit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), "supabase", "migrations");

/** Latest definition of a function across all migrations, in filename order. */
function latestFunctionBody(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let body: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(DIR, f), "utf8");
    const idx = sql.lastIndexOf(marker);
    if (idx === -1) continue;
    const rest = sql.slice(idx);
    const next = rest.indexOf("CREATE OR REPLACE FUNCTION", marker.length);
    body = next === -1 ? rest : rest.slice(0, next);
  }
  if (!body) throw new Error(`No migration defines public.${name}`);
  return body;
}

const PERIOD_GUARDED_WRITERS = [
  "issue_vendor_credit_note_atomic",
  "apply_vendor_credit_to_bill_atomic",
  "unapply_vendor_credit_from_bill_atomic",
  "reverse_vendor_credit_note_atomic",
  "resolve_reversal_intent_vendor_credit_note",
];

describe("vendor credit — fiscal period close interaction", () => {
  for (const fn of PERIOD_GUARDED_WRITERS) {
    it(`${fn} calls the canonical period guard`, () => {
      const body = latestFunctionBody(fn);
      expect(body).toContain("is_period_open");
    });

    it(`${fn} raises rather than silently continuing on a closed period`, () => {
      const body = latestFunctionBody(fn);
      expect(body).toMatch(/RAISE\s+EXCEPTION/i);
    });
  }

  it("the FIFO applier delegates to the guarded single-bill writer", () => {
    // apply_vendor_credit_fifo_atomic has no inline guard by design: it loops
    // over bills and calls apply_vendor_credit_to_bill_atomic, inheriting it.
    // If it ever stops delegating it must grow its own guard.
    const body = latestFunctionBody("apply_vendor_credit_fifo_atomic");
    expect(
      /apply_vendor_credit_to_bill_atomic/.test(body) || /is_period_open/.test(body),
    ).toBe(true);
  });

  it("no vendor-credit writer inserts journal rows directly (ADR 0123)", () => {
    for (const fn of PERIOD_GUARDED_WRITERS) {
      const body = latestFunctionBody(fn);
      expect(body).not.toMatch(/INSERT\s+INTO\s+public\.journal_entry_lines/i);
      expect(body).not.toMatch(/INSERT\s+INTO\s+public\.journal_entries\b/i);
    }
  });
});

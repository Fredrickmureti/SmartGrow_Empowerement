/**
 * Ratchet — Aged Payables is a point-in-time projection of the AP subledger.
 *
 * The payables page must:
 *   - read `get_ap_aging_summary` through the typed `useApAging` hook,
 *   - never recompute buckets, residuals or totals in the browser,
 *   - never read `bills.status` / `bills.amount_paid` to decide openness,
 *   - surface the GL reconciliation variance instead of hiding it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(process.cwd(), "src");
const PAGE = readFileSync(join(ROOT, "pages/purchases/AgedPayables.tsx"), "utf8");
const HOOK = readFileSync(join(ROOT, "hooks/useApAging.ts"), "utf8");

describe("Aged Payables — point-in-time engine", () => {
  it("the page is typed (no @ts-nocheck escape hatch)", () => {
    expect(PAGE).not.toContain("@ts-nocheck");
  });

  it("the page reads the canonical aging hook only", () => {
    expect(PAGE).toContain("useApAging");
    expect(PAGE).not.toContain("supabase.rpc");
    expect(PAGE).not.toContain('from("bills")');
  });

  it("the hook is backed by the as-of aging engine and its reconciliation", () => {
    expect(HOOK).toContain("get_ap_aging_summary");
    expect(HOOK).toContain("finance_ap_aging_reconciliation");
  });

  it("the page does not re-derive totals or buckets in the browser", () => {
    expect(PAGE).not.toMatch(/\.reduce\(/);
    expect(PAGE).not.toMatch(/days(30|60|90)\s*[:=]\s*acc\./);
    expect(PAGE).not.toContain("bucketForDaysOverdue");
  });

  it("the page shows the AP control-account variance", () => {
    expect(PAGE).toContain("reconciliation");
    expect(PAGE).toContain("inBalance");
  });

  it("openness is never decided from bill status or amount_paid", () => {
    expect(PAGE).not.toContain("amount_paid");
    expect(HOOK).not.toContain("amount_paid");
  });

  // Phase 8 — export parity. A CSV/XLSX/PDF export must be the same engine
  // answer as the screen, just unpaged: re-run the query, never re-aggregate
  // the rows already in the browser.
  it("exports re-run the engine unpaged instead of exporting the visible page", () => {
    expect(PAGE).toContain("fetchApAging(");
    expect(PAGE).toMatch(/fetchApAging\(\{\s*\.\.\.agingArgs,\s*limit:\s*null/);
    // The exported rows come from the fresh full result, not from component state.
    expect(PAGE).toMatch(/full\.vendors\.map\(/);
    expect(PAGE).not.toMatch(/vendors\.map\([^)]*\)\s*,?\s*\/\/?\s*export/i);
  });

  it("export grand total is the engine total, not a browser sum", () => {
    expect(PAGE).toMatch(/vendor:\s*"TOTAL"/);
    expect(PAGE).toMatch(/full\.totals\.(not_due|current|days30|days60|days90|total)/);
    expect(PAGE).not.toMatch(/reduce\(\s*\(/);
  });

  it("export carries the same as-of date and reporting currency as the screen", () => {
    expect(PAGE).toMatch(/subtitle:\s*`As of \$\{asOfDate\}`/);
    expect(PAGE).toMatch(/currency:\s*full\.currency/);
  });
});


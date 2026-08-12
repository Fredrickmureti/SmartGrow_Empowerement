/**
 * Phase 7d ratchet — AP credit position provenance & vendor-credit tie-out.
 *
 * Two invariants:
 *
 * 1. Unapplied vendor credit has exactly ONE definition,
 *    `public.finance_ap_vendor_credit` (projected from
 *    `vendor_credit_balances`). No AP ageing / supplier-balance surface may
 *    re-derive it from document columns such as
 *    `vendor_credit_notes.total - amount_applied`.
 * 2. `vendor_credit_tieout` compares the vendor-credit subledger against the
 *    GL control account and feeds `snapshot_control_account_drift()`, so drift
 *    lands in `control_account_drift_log` instead of going unnoticed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === "test") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !p.endsWith(join("supabase", "types.ts"))) {
      out.push(p);
    }
  }
  return out;
}

function migrationsWith(needle: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(join(MIGRATIONS, f), "utf8").includes(needle));
}

function latestMigrationBodyWith(needle: string): string {
  const files = migrationsWith(needle);
  if (files.length === 0) throw new Error(`No migration contains ${needle}`);
  return readFileSync(join(MIGRATIONS, files[files.length - 1]), "utf8");
}

describe("AP credit position provenance", () => {
  const files = walk(SRC);

  it("finance_ap_vendor_credit is defined from vendor_credit_balances", () => {
    const sql = latestMigrationBodyWith("CREATE OR REPLACE VIEW public.finance_ap_vendor_credit");
    const idx = sql.indexOf("CREATE OR REPLACE VIEW public.finance_ap_vendor_credit");
    const body = sql.slice(idx, sql.indexOf(";", idx));
    expect(body).toContain("vendor_credit_balances");
    expect(body).not.toContain("vendor_credit_notes");
    // Mirrors the AR view's shape and 0.01 floor.
    expect(body).toContain("base_credit_amount");
    expect(body).toMatch(/balance\s*>\s*0\.01/);
  });

  it("the AP summary and aged-payables SQL net the view, never document columns", () => {
    for (const fn of ["get_ap_summary", "get_ap_aging_summary", "get_ar_ap_aging_from_ledger"]) {
      const sql = latestMigrationBodyWith(`CREATE OR REPLACE FUNCTION public.${fn}`);
      const idx = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
      const rest = sql.slice(idx);
      const next = rest.indexOf("CREATE OR REPLACE FUNCTION", 40);
      const body = next === -1 ? rest : rest.slice(0, next);
      expect(body).toContain("finance_ap_vendor_credit");
      expect(body).not.toMatch(/vendor_credit_notes[\s\S]{0,200}amount_applied/);
    }
  });

  it("client AP surfaces read the canonical view only", () => {
    const openItems = readFileSync(join(SRC, "services/finance/openItems.ts"), "utf8");
    expect(openItems).toContain("finance_ap_vendor_credit");
    // The pre-7b defect: an explicit "AP has no credit-position analogue" branch.
    expect(openItems).not.toMatch(/no credit-position analogue/i);

    // No AP position surface may query the credit-note document table for a
    // credit balance. Document workspaces may still read `amount_applied` to
    // render a single note; what is forbidden is deriving a supplier's credit
    // position from it.
    const offenders = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      const isPositionSurface =
        /(aging|ageing|open[_-]?items|ap_summary|net_position)/i.test(src) &&
        /(finance_ap_open_items|get_ap_summary|get_ap_aging_summary|fetchContactOpenItemAging)/.test(
          src,
        );
      if (!isPositionSurface) return false;
      return /from\(\s*["'`]vendor_credit_notes/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});

describe("vendor credit tie-out is monitored", () => {
  it("vendor_credit_tieout compares the subledger against the GL control account", () => {
    const sql = latestMigrationBodyWith("vendor_credit_tieout");
    const idx = sql.indexOf("VIEW public.vendor_credit_tieout");
    const body = sql.slice(idx);
    expect(body).toContain("vendor_credit_balances");
    expect(body).toContain("journal_entry_lines");
    expect(body).toContain("'vendor_credit'");
    expect(body).toMatch(/drift/);
  });

  it("snapshot_control_account_drift logs vendor-credit drift", () => {
    const sql = latestMigrationBodyWith(
      "CREATE OR REPLACE FUNCTION public.snapshot_control_account_drift",
    );
    const idx = sql.lastIndexOf("CREATE OR REPLACE FUNCTION public.snapshot_control_account_drift");
    const body = sql.slice(idx);
    expect(body).toContain("vendor_credit_tieout");
    expect(body).toContain("control_account_drift_log");
    expect(body).toMatch(/abs\(drift\)\s*>\s*0\.005/);
  });
});

/**
 * Ratchet — `overdue` is a derived condition, not a stored bill status.
 *
 * AP remediation Step 2b retired the trigger `trg_bill_overdue_check`
 * (function `mark_overdue_bills`), which used to overwrite `bills.status`
 * with `overdue`, destroying the real lifecycle state (received / partial)
 * and going stale the moment the clock or a payment moved.
 *
 * The enum value stays for back-compat with historical rows and reports.
 * These assertions stop it from becoming a stored state again.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const SRC = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC).filter(
  (f) => !f.includes(join("src", "test")) && !f.includes("__tests__"),
);

function migrationSql(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

describe("bill overdue — derived, never stored", () => {
  it("the stored-overdue trigger is dropped by a migration", () => {
    const sql = migrationSql();
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_bill_overdue_check ON public\.bills/i);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.mark_overdue_bills/i);
  });

  it("no client code writes 'overdue' onto a bill", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      // A bill-status write: `status: "overdue"` inside a file that touches bills.
      if (!/from\(\s*["'`]bills["'`]\s*\)/.test(src)) continue;
      if (/status:\s*["'`]overdue["'`]/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("the Bills list and record page derive the displayed status", () => {
    const list = readFileSync(join(SRC, "pages", "Bills.tsx"), "utf8");
    const record = readFileSync(
      join(SRC, "features", "purchases", "bills", "billView.tsx"),
      "utf8",
    );
    expect(list).toContain("deriveBillStatus");
    expect(record).toContain("deriveBillStatus");
  });

  it("the derivation helper is the single source of the overdue rule", () => {
    const helper = readFileSync(
      join(SRC, "features", "purchases", "bills", "billStatus.ts"),
      "utf8",
    );
    expect(helper).toContain("export function isBillOverdue");
    expect(helper).toContain("export function deriveBillStatus");
  });
});

/**
 * Architecture guard — Proforma Invoice is a non-accounting commercial document
 * governed by the canonical Sales lifecycle patterns.
 *
 * Confirms:
 *  1. Nothing in the proforma reachable path posts to the ledger, AR, tax
 *     liability or inventory.
 *  2. Creation goes through `create_proforma_atomic` (server-side numbering and
 *     totals), never a raw client insert into `proforma_invoices`.
 *  3. Status changes go through `set_proforma_status_atomic`; the client never
 *     writes `status` directly.
 *  4. Conversion goes through `convert_proforma_to_invoice_atomic`.
 *  5. The hardening migration exists: business-scoped numbering with an advisory
 *     lock, a unique number index, permission-scoped item RLS, and the
 *     converted-document freeze/delete guards.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "src");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

const proformaFiles = walk(ROOT).filter(
  (f) => /proforma/i.test(f) && !f.includes("__tests__"),
);

function migrationsText(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
    .join("\n");
}

describe("proforma domain architecture", () => {
  it("has proforma source files to guard", () => {
    expect(proformaFiles.length).toBeGreaterThan(0);
  });

  it("never touches accounting or inventory tables", () => {
    const forbidden = [
      "journal_entries",
      "journal_entry_lines",
      "accounting_events",
      "stock_movements",
      "stock_quants",
      "payments",
      "customer_credit_movements",
    ];
    for (const file of proformaFiles) {
      const src = readFileSync(file, "utf8");
      for (const table of forbidden) {
        expect(
          src.includes(`"${table}"`) || src.includes(`'${table}'`),
          `${file} must not reference ${table}`,
        ).toBe(false);
      }
    }
  });

  it("creates proformas through the atomic RPC only", () => {
    const hook = readFileSync(join(ROOT, "hooks", "useProformaInvoices.ts"), "utf8");
    expect(hook).toContain("create_proforma_atomic");
    expect(hook).not.toContain('.from("proforma_invoices")\n        .insert');
    expect(hook).not.toContain('from("proforma_invoice_items").insert');
  });

  it("routes status changes through the state machine", () => {
    const hook = readFileSync(join(ROOT, "hooks", "useProformaInvoices.ts"), "utf8");
    expect(hook).toContain("set_proforma_status_atomic");
    for (const file of proformaFiles.concat(join(ROOT, "pages", "ProformaInvoices.tsx"))) {
      const src = readFileSync(file, "utf8");
      expect(/update\(\s*\{\s*status:/.test(src), `${file} writes status directly`).toBe(false);
    }
  });

  it("converts through the atomic converter", () => {
    const hook = readFileSync(join(ROOT, "hooks", "useProformaInvoices.ts"), "utf8");
    expect(hook).toContain("convert_proforma_to_invoice_atomic");
  });

  it("ships the hardening migration", () => {
    const sql = migrationsText();
    expect(sql).toContain("pg_advisory_xact_lock(hashtext('proforma_number_'");
    expect(sql).toContain("ux_proforma_invoices_number");
    expect(sql).toContain("proforma_invoice_items_update_v2");
    expect(sql).toContain("proforma_freeze_after_convert");
    expect(sql).toContain("proforma_block_converted_delete");
    expect(sql).toContain("proforma_status_write_guard");
    expect(sql).toContain("expire_overdue_proformas");
  });
});

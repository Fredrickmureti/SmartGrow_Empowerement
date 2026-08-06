/**
 * Architecture ratchet — POS credit sale has ONE document writer.
 *
 * ADR 0128. A POS on-account sale must materialise its AR invoice through
 * `create_pos_credit_sale_invoice_atomic` (header + lines + the
 * `pos_transactions.invoice_id` link in one transaction, idempotent by POS
 * transaction id). Client-side multi-step creation is banned: a mid-sequence
 * failure would leave a completed sale with a missing or partial receivable.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SELF = "pos-credit-sale-single-writer.test.ts";

function rgFiles(pattern: string, paths: string[]): string[] {
  try {
    return execSync(
      `rg -lU ${JSON.stringify(pattern)} ${paths.join(" ")} -g '*.ts' -g '*.tsx'`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes(SELF));
  } catch {
    return [];
  }
}

function latestMigrationWith(pattern: string): string {
  const out = execSync(`rg -l ${JSON.stringify(pattern)} supabase/migrations`, {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .sort();
  const last = out[out.length - 1];
  if (!last) throw new Error(`no migration contains ${pattern}`);
  return last;
}

describe("POS credit sale single writer (ADR 0128)", () => {
  const hook = readFileSync("src/hooks/pos/usePOSCreditSale.ts", "utf8");

  it("the POS credit sale hook calls the atomic writer", () => {
    expect(hook).toMatch(/create_pos_credit_sale_invoice_atomic/);
  });

  it("no POS code inserts invoice documents directly", () => {
    const offenders = rgFiles(
      'from\\("(invoices|invoice_items)"\\)\\s*\\.insert',
      ["src/hooks/pos", "src/apps/pos", "src/components/pos"],
    );
    expect(offenders).toEqual([]);
  });

  it("no POS code reserves invoice numbers on the client", () => {
    const offenders = rgFiles('get_next_invoice_number', [
      "src/hooks/pos",
      "src/apps/pos",
      "src/components/pos",
    ]);
    expect(offenders).toEqual([]);
  });

  it("the writer is SECURITY DEFINER, org-guarded and idempotent", () => {
    const sql = readFileSync(
      latestMigrationWith("create_pos_credit_sale_invoice_atomic"),
      "utf8",
    );
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path TO 'public'/);
    expect(sql).toMatch(/_assert_org_member\(/);
    // Idempotency anchor: an already-linked invoice short-circuits.
    expect(sql).toMatch(/IF v_txn\.invoice_id IS NOT NULL THEN[\s\S]{0,80}RETURN/);
    // Credit amount is derived server-side from recorded tenders.
    expect(sql).toMatch(/pos_transaction_payments[\s\S]{0,200}'credit'/);
  });
});

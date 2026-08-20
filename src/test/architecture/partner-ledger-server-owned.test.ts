/**
 * Guard: the Partner Ledger is server-owned.
 *
 * Opening balances, running balances and closing balances are accounting
 * output and belong in SQL (`finance_partner_ledger`). This test locks in
 * three invariants that were violated by the previous implementation:
 *
 *  1. The report page reads the canonical hook/service, not the ledger views.
 *  2. No client-side ledger paging loop and no JS balance accumulation.
 *  3. Branch scoping is strict — never `branch_id = X OR branch_id IS NULL`,
 *     which absorbed unbranched entries into a branch-scoped report.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const PAGE = "src/pages/reports/PartnerLedger.tsx";
const SERVICE = "src/services/finance/partnerLedger.ts";
const HOOK = "src/hooks/usePartnerLedger.ts";

describe("Partner Ledger — server-owned balances", () => {
  it("the page consumes the canonical hook", () => {
    const src = read(PAGE);
    expect(src).toContain("usePartnerLedger");
  });

  it("the page never queries the ledger views directly", () => {
    const src = read(PAGE);
    expect(src).not.toContain("customer_ledger_entries");
    expect(src).not.toContain("vendor_ledger_entries");
    expect(src).not.toContain("journal_entry_lines");
  });

  it("the page has no client-side paging loop", () => {
    const src = read(PAGE);
    expect(src).not.toContain("while (true)");
    expect(src).not.toMatch(/\.range\(/);
  });

  it("the page does not accumulate balances in JavaScript", () => {
    const src = read(PAGE);
    // The old code folded `opening_balance +=` / `balance += debit - credit`.
    expect(src).not.toMatch(/opening_balance\s*\+=/);
    expect(src).not.toMatch(/running_balance\s*=\s*balance/);
    expect(src).not.toMatch(/balance\s*\+=\s*txn\./);
  });

  it("no surface uses the leaky branch predicate", () => {
    for (const file of [PAGE, SERVICE, HOOK]) {
      expect(read(file)).not.toContain("branch_id.is.null");
    }
  });

  it("the service is the only caller of the ledger RPCs", () => {
    const service = read(SERVICE);
    expect(service).toContain("finance_partner_ledger");
    expect(service).toContain("finance_partner_ledger_reconciliation");
  });

  it("the hook exposes the GL tie-out", () => {
    expect(read(HOOK)).toContain("usePartnerLedgerReconciliation");
  });
  it("grand totals come from the engine's totals envelope, not JS addition", () => {
    const src = read(PAGE);
    expect(src).not.toMatch(/grand\.debit\s*\+=/);
    expect(src).not.toMatch(/grand\.credit\s*\+=/);
    expect(src).toContain("totals.total_debit");
    expect(src).toContain("totals.total_credit");
    expect(src).toContain("totals.closing_balance");
  });

  it("drill-down targets the originating journal entry", () => {
    const src = read(PAGE);
    expect(src).toContain("_journalEntryId");
    expect(src).toContain('sourceType="journal_entry"');
    // A date-range drill-down cannot prove which posting produced the row.
    expect(src).not.toContain("DrillDownDialog");
  });

  it("the service carries the journal entry id through to the page", () => {
    expect(read(SERVICE)).toContain("journal_entry_id");
  });
});

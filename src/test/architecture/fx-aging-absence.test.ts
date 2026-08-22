/**
 * ADR 0136 ratchet — AR/AP aging must not coerce a missing base-currency
 * residual into zero.
 *
 * `get_ar_ap_aging_from_ledger` returns SQL NULL for `residual_amount` when a
 * document is denominated in a currency with no rate on file. Coercing that to
 * 0 understates the position and makes an incomplete total look complete.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("ADR 0136 — aging absence propagation", () => {
  const hook = read("src/hooks/useAgingReport.ts");

  it("does not coerce a null residual to zero", () => {
    expect(hook).not.toMatch(/Number\(row\.residual_amount\)\s*\|\|\s*0/);
  });

  it("counts unconvertible documents at report and contact level", () => {
    expect(hook).toMatch(/unconvertibleDocumentCount/);
    expect(hook).toMatch(/balance_due:\s*null/);
  });

  it("surfaces the incomplete total to the operator", () => {
    expect(read("src/pages/reports/AgingReport.tsx")).toMatch(/unconvertibleDocumentCount/);
  });

  it("renders missing-rate balances through BaseCurrencyAmount", () => {
    for (const p of [
      "src/pages/finance/AccountsReceivable.tsx",
      "src/pages/finance/AccountsPayable.tsx",
      "src/pages/sales/Collections.tsx",
    ]) {
      const src = read(p);
      expect(src).toMatch(/BaseCurrencyAmount/);
      expect(src).not.toMatch(/formatCurrency\((doc|d)\.balance_due\)/);
    }
  });

  it("discloses excluded documents on printed and previewed statements", () => {
    for (const p of [
      "src/components/sales/StatementPreview.tsx",
      "src/components/purchases/VendorStatementPreview.tsx",
      "src/services/documents/snapshots/salesCustomerStatement.ts",
      "src/services/documents/snapshots/purchasesVendorStatement.ts",
      "src/components/contacts/ContactAgingBreakdown.tsx",
    ]) {
      expect(read(p), `${p} must disclose unconvertible documents`).toMatch(
        /unconvertible_document_count/,
      );
    }
  });

  it("keeps the shared aging helper honest about absence", () => {
    const openItems = read("src/services/finance/openItems.ts");
    expect(openItems).toMatch(/unconvertible_document_count/);
    expect(openItems).not.toMatch(/base_residual_amount\s*\?\?\s*(row|item)\.residual_amount/);
    expect(read("src/services/finance/aging.ts")).toMatch(/unconvertible_document_count/);
  });

  it("shows rate provenance and a currency picker on the FX settings surfaces", () => {
    const controls = read("src/components/finance/FinanceAccountingControls.tsx");
    expect(controls).toMatch(/ExchangeRatePanel/);

    const settings = read("src/components/settings/CurrencySettings.tsx");
    // Provenance columns, and precedence explained in plain words.
    expect(settings).toMatch(/provider_key/);
    expect(settings).toMatch(/published_at/);
    expect(settings).toMatch(/Overrides win over/);
    // Currency is chosen from the catalogue, never free-typed.
    expect(settings).not.toMatch(/placeholder="[A-Z]{3}"/);
  });
});

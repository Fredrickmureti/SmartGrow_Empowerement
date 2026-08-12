/**
 * ADR 0135 — currency integrity ratchet.
 *
 * 1. Purchasing create surfaces must not hardcode a currency literal; the
 *    document currency is supplier-proposed and database-stamped.
 * 2. Supplier currency editing must use the canonical `CurrencyCombobox`
 *    (backed by `public.currencies`), never a free-text input.
 * 3. The browser must never compute an exchange rate — only the database
 *    resolvers (`resolve_exchange_rate` / `require_exchange_rate`) may.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const PURCHASING_CREATE_SURFACES = [
  "src/features/purchases/bills/BillCreatePage.tsx",
  "src/features/purchases/orders/PurchaseOrderCreatePage.tsx",
];

const SUPPLIER_CURRENCY_SURFACES = [
  "src/features/purchases/suppliers/SupplierCreatePage.tsx",
  "src/features/purchases/suppliers/SupplierRecordTabs.tsx",
];

describe("ADR 0135 — currency integrity", () => {
  it.each(PURCHASING_CREATE_SURFACES)(
    "%s stamps a supplier-resolved currency, not a literal",
    (path) => {
      const src = read(path);
      expect(src).toMatch(/useSupplierDocumentCurrency/);
      expect(src).toMatch(/currency:\s*documentCurrency/);
      // No ISO literal assigned as the document currency.
      expect(src).not.toMatch(/currency:\s*["'][A-Z]{3}["']/);
    },
  );

  it.each(SUPPLIER_CURRENCY_SURFACES)(
    "%s edits supplier currency through CurrencyCombobox",
    (path) => {
      const src = read(path);
      expect(src).toMatch(/CurrencyCombobox/);
      // The old free-text pattern (uppercasing a raw input) must not return.
      expect(src).not.toMatch(/e\.target\.value\.toUpperCase\(\)/);
    },
  );

  it("the supplier currency hook resolves party → role server-side", () => {
    const src = read("src/features/purchases/suppliers/useSupplierDocumentCurrency.ts");
    expect(src).toMatch(/resolveSupplierDefaults/);
    expect(src).toMatch(/baseCurrency/);
  });

  it("no client-side FX arithmetic on purchasing surfaces", () => {
    for (const path of [...PURCHASING_CREATE_SURFACES, ...SUPPLIER_CURRENCY_SURFACES]) {
      const src = read(path);
      expect(src).not.toMatch(/exchange_rate\s*[*/]/);
      expect(src).not.toMatch(/currency_rate\s*[*/]/);
    }
  });
});
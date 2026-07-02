/**
 * Regression tests pinning the invoice → journal entry arithmetic.
 *
 * Architecture (ADR 0026): `confirmInvoiceAndPostGL` resolves accounts on the
 * client, assembles the main JE lines (AR debit, revenue credit NET of tax,
 * VAT credit) and posts them atomically via `confirm_invoice_atomic` /
 * `confirm_invoice_and_release_stock_atomic`. COGS is NOT posted here — it is
 * posted exclusively at goods-issue by `complete_delivery_atomic`.
 *
 * `invoice_items.line_total` is tax-EXCLUSIVE (Odoo convention). Revenue is
 * credited at `line_total`; tax is credited separately to VAT Payable. These
 * tests assert that, for any tax rate and product mix, the JE handed to the
 * RPC is balanced, revenue is NET of tax, and no COGS line leaks into the
 * invoice JE.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { confirmInvoiceAndPostGL } from "../confirmInvoiceGL";
import type { Invoice } from "../../useInvoices";
import type { DefaultAccountMappings } from "../../useDefaultAccounts";

// --- Supabase mock ----------------------------------------------------------
const tableState: Record<string, any[]> = {
  invoice_items: [],
  products: [],
  contacts: [],
  invoices: [],
};

// Captured RPC invocations + the configurable result the mock returns.
const rpcCalls: Array<{ fn: string; args: any }> = [];
let rpcResult: { data: any; error: any } = {
  data: { success: true, journal_entry_id: "je-1" },
  error: null,
};

vi.mock("@/integrations/supabase/client", () => {
  const buildBuilder = (table: string) => {
    let rows = [...(tableState[table] ?? [])];
    const builder: any = {
      select: () => builder,
      eq: (col: string, val: any) => {
        rows = rows.filter((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: any[]) => {
        rows = rows.filter((r) => vals.includes(r[col]));
        return builder;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
      then: (resolve: any) => resolve({ data: rows, error: null }),
    };
    return builder;
  };
  return {
    supabase: {
      from: (table: string) => buildBuilder(table),
      rpc: async (fn: string, args: any) => {
        rpcCalls.push({ fn, args });
        return rpcResult;
      },
    },
  };
});

// --- Test fixtures ----------------------------------------------------------
const SYSTEM_DEFAULTS: DefaultAccountMappings = {
  accounts_receivable_id: "ar-default",
  sales_revenue_id: "rev-default",
  cost_of_goods_sold_id: "cogs-default",
  inventory_account_id: "inv-default",
  operating_expenses_id: "exp-default",
  cash_id: "cash-default",
  accounts_payable_id: "ap-default",
  sales_tax_payable_id: "vat-default",
  purchase_tax_id: null,
  retained_earnings_id: null,
  opening_balance_equity_id: null,
  discount_given_id: null,
  bank_fees_id: null,
  exchange_gain_loss_id: null,
} as any;

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    invoice_number: "INV-00001",
    status: "draft",
    contact_id: "contact-1",
    issue_date: "2026-04-18",
    subtotal: 0,
    tax_amount: 0,
    total: 0,
    ...overrides,
  } as any;
}

function makeDeps() {
  return {
    hasRequiredAccounts: () => true,
    getInvoiceAccountMappings: () => ({
      receivable_account_id: "ar-default",
      revenue_account_id: "rev-default",
      tax_liability_account_id: "vat-default",
    }),
    systemDefaults: SYSTEM_DEFAULTS,
    logAction: vi.fn(),
    userId: "user-1",
    // Isolate JE assembly: don't drive the delivery-completion branch here.
    releaseStock: false,
  };
}

/** Pull the main JE lines from the single captured RPC call. */
function capturedMainLines(): Array<{ account_id: string; debit: number; credit: number }> {
  expect(rpcCalls).toHaveLength(1);
  return rpcCalls[0].args.p_main_lines as any;
}

beforeEach(() => {
  Object.keys(tableState).forEach((k) => (tableState[k] = []));
  rpcCalls.length = 0;
  rpcResult = { data: { success: true, journal_entry_id: "je-1" }, error: null };
});

// --- Tests ------------------------------------------------------------------
describe("confirmInvoiceAndPostGL — JE arithmetic", () => {
  it("balances a 16% VAT invoice and credits revenue NET of tax", async () => {
    // line_total is tax-EXCLUSIVE: revenue 1000, VAT 160, total 1160
    tableState.invoice_items = [
      { invoice_id: "inv-1", product_id: "p1", quantity: 1, unit_price: 1000, line_total: 1000, tax_amount: 160 },
    ];
    tableState.products = [
      { id: "p1", sales_account_id: "rev-product", cogs_account_id: null, inventory_account_id: null, cost_price: 0, track_inventory: false },
    ];

    const inv = makeInvoice({ subtotal: 1000, tax_amount: 160, total: 1160 });
    const jeId = await confirmInvoiceAndPostGL(inv, makeDeps());

    expect(jeId).toBe("je-1");
    expect(rpcCalls[0].fn).toBe("confirm_invoice_atomic");

    const lines = capturedMainLines();
    const dr = lines.reduce((s, e) => s + (e.debit || 0), 0);
    const cr = lines.reduce((s, e) => s + (e.credit || 0), 0);
    expect(dr).toBe(1160);
    expect(cr).toBe(1160);

    expect(lines.find((e) => e.account_id === "ar-default")?.debit).toBe(1160);
    expect(lines.find((e) => e.account_id === "rev-product")?.credit).toBe(1000); // NET
    expect(lines.find((e) => e.account_id === "vat-default")?.credit).toBe(160);
  });

  it("posts ONE balanced JE for an inventory product — no COGS at invoice (ADR 0026)", async () => {
    tableState.invoice_items = [
      { invoice_id: "inv-1", product_id: "merc", quantity: 1, unit_price: 2_500_000, line_total: 2_500_000, tax_amount: 400_000 },
    ];
    tableState.products = [
      { id: "merc", sales_account_id: "sales-rev", cogs_account_id: "cogs-acc", inventory_account_id: "inv-acc", cost_price: 2_000_000, track_inventory: true },
    ];

    const inv = makeInvoice({ subtotal: 2_500_000, tax_amount: 400_000, total: 2_900_000 });
    await confirmInvoiceAndPostGL(inv, makeDeps());

    // Exactly one RPC call (revenue JE). COGS posts at delivery, not here.
    expect(rpcCalls).toHaveLength(1);
    const lines = capturedMainLines();
    const dr = lines.reduce((s, e) => s + (e.debit || 0), 0);
    const cr = lines.reduce((s, e) => s + (e.credit || 0), 0);
    expect(dr).toBe(2_900_000);
    expect(cr).toBe(2_900_000);
    expect(lines.find((e) => e.account_id === "sales-rev")?.credit).toBe(2_500_000);
    expect(lines.find((e) => e.account_id === "vat-default")?.credit).toBe(400_000);
    // No COGS / inventory lines leak into the invoice JE.
    expect(lines.some((e) => e.account_id === "cogs-acc")).toBe(false);
    expect(lines.some((e) => e.account_id === "inv-acc")).toBe(false);
  });

  it("balances zero-tax invoice (regression: must still work)", async () => {
    tableState.invoice_items = [
      { invoice_id: "inv-1", product_id: "p1", quantity: 2, unit_price: 500, line_total: 1000, tax_amount: 0 },
    ];
    tableState.products = [
      { id: "p1", sales_account_id: "rev-1", cogs_account_id: null, inventory_account_id: null, cost_price: 0, track_inventory: false },
    ];
    const inv = makeInvoice({ subtotal: 1000, tax_amount: 0, total: 1000 });
    await confirmInvoiceAndPostGL(inv, makeDeps());

    const lines = capturedMainLines();
    const dr = lines.reduce((s, e) => s + (e.debit || 0), 0);
    const cr = lines.reduce((s, e) => s + (e.credit || 0), 0);
    expect(dr).toBe(1000);
    expect(cr).toBe(1000);
    expect(lines.find((e) => e.account_id === "rev-1")?.credit).toBe(1000);
  });

  it("balances multi-line invoice with two different revenue accounts", async () => {
    tableState.invoice_items = [
      { invoice_id: "inv-1", product_id: "pa", quantity: 1, unit_price: 500, line_total: 500, tax_amount: 80 },
      { invoice_id: "inv-1", product_id: "pb", quantity: 1, unit_price: 300, line_total: 300, tax_amount: 48 },
    ];
    tableState.products = [
      { id: "pa", sales_account_id: "rev-a", cogs_account_id: null, inventory_account_id: null, cost_price: 0, track_inventory: false },
      { id: "pb", sales_account_id: "rev-b", cogs_account_id: null, inventory_account_id: null, cost_price: 0, track_inventory: false },
    ];
    const inv = makeInvoice({ subtotal: 800, tax_amount: 128, total: 928 });
    await confirmInvoiceAndPostGL(inv, makeDeps());

    const lines = capturedMainLines();
    const dr = lines.reduce((s, e) => s + (e.debit || 0), 0);
    const cr = lines.reduce((s, e) => s + (e.credit || 0), 0);
    expect(dr).toBe(928);
    expect(cr).toBe(928);
    expect(lines.find((e) => e.account_id === "rev-a")?.credit).toBe(500);
    expect(lines.find((e) => e.account_id === "rev-b")?.credit).toBe(300);
    expect(lines.find((e) => e.account_id === "vat-default")?.credit).toBe(128);
  });
});

describe("confirmInvoiceAndPostGL — error surface", () => {
  it("does NOT append 'Check your account mappings' when error is a balance failure", async () => {
    tableState.invoice_items = [
      { invoice_id: "inv-1", product_id: null, quantity: 1, unit_price: 100, line_total: 100, tax_amount: 0 },
    ];
    rpcResult = { data: null, error: { message: "Journal entry not balanced: debit=100 credit=200" } };
    const inv = makeInvoice({ subtotal: 100, tax_amount: 0, total: 100 });

    await expect(confirmInvoiceAndPostGL(inv, makeDeps())).rejects.toThrow(/Journal entry not balanced/);
    await expect(confirmInvoiceAndPostGL(inv, makeDeps())).rejects.not.toThrow(/Check your account mappings/);
  });

  it("DOES append 'Check your account mappings' when error mentions account", async () => {
    tableState.invoice_items = [
      { invoice_id: "inv-1", product_id: null, quantity: 1, unit_price: 100, line_total: 100, tax_amount: 0 },
    ];
    rpcResult = { data: null, error: { message: 'null value in column "account_id" violates not-null constraint' } };
    const inv = makeInvoice({ subtotal: 100, tax_amount: 0, total: 100 });

    await expect(confirmInvoiceAndPostGL(inv, makeDeps())).rejects.toThrow(/Check your account mappings/);
  });
});

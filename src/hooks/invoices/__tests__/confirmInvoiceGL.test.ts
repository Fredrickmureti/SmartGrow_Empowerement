/**
 * Phase 6.1 contract: invoice GL account resolution belongs to the server.
 *
 * `confirmInvoiceAndPostGL` must NOT resolve accounts, must NOT build journal
 * lines, and must NOT send `p_main_lines` — `_confirm_invoice_core` rejects
 * client-supplied lines. These tests pin that seam plus the error surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { confirmInvoiceAndPostGL } from "../confirmInvoiceGL";
import type { Invoice } from "../../useInvoices";

const rpcCalls: Array<{ fn: string; args: any }> = [];
let rpcResult: { data: any; error: any } = {
  data: { success: true, journal_entry_id: "je-1" },
  error: null,
};

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      throw new Error("confirmInvoiceAndPostGL must not read tables for GL resolution");
    },
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return rpcResult;
    },
  },
}));

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "inv-1",
    invoice_number: "INV-00001",
    status: "draft",
    contact_id: "contact-1",
    issue_date: "2026-04-18",
    subtotal: 1000,
    tax_amount: 160,
    total: 1160,
    ...overrides,
  } as any;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    logAction: vi.fn(),
    userId: "user-1",
    releaseStock: false,
    ...overrides,
  } as any;
}

beforeEach(() => {
  rpcCalls.length = 0;
  rpcResult = { data: { success: true, journal_entry_id: "je-1" }, error: null };
});

describe("confirmInvoiceAndPostGL — server-authoritative GL", () => {
  it("calls confirm_invoice_atomic without any client-built journal lines", async () => {
    const jeId = await confirmInvoiceAndPostGL(makeInvoice(), makeDeps());

    expect(jeId).toBe("je-1");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("confirm_invoice_atomic");
    expect(rpcCalls[0].args).not.toHaveProperty("p_main_lines");
    expect(rpcCalls[0].args.p_final_status).toBe("sent");
  });

  it("uses the stock-releasing RPC by default, still without journal lines", async () => {
    await confirmInvoiceAndPostGL(makeInvoice(), makeDeps({ releaseStock: undefined }));

    expect(rpcCalls[0].fn).toBe("confirm_invoice_and_release_stock_atomic");
    expect(rpcCalls[0].args).not.toHaveProperty("p_main_lines");
    expect(rpcCalls[0].args.p_release_stock).toBe(true);
  });

  it("refuses to confirm a non-draft invoice before touching the server", async () => {
    await expect(
      confirmInvoiceAndPostGL(makeInvoice({ status: "sent" } as any), makeDeps()),
    ).rejects.toThrow(/Only draft invoices/);
    expect(rpcCalls).toHaveLength(0);
  });

  it("no longer contains client-side account resolution", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/hooks/invoices/confirmInvoiceGL.ts"),
      "utf8",
    );
    expect(src).not.toContain("resolveLineAccounts");
    expect(src).not.toContain("p_main_lines");
    expect(src).not.toContain("default_receivable_account_id");
  });
});

describe("confirmInvoiceAndPostGL — error surface", () => {
  it("does NOT append 'Check your account mappings' for a balance failure", async () => {
    rpcResult = { data: null, error: { message: "Journal entry not balanced: debit=100 credit=200" } };

    await expect(confirmInvoiceAndPostGL(makeInvoice(), makeDeps())).rejects.toThrow(
      /Journal entry not balanced/,
    );
    await expect(confirmInvoiceAndPostGL(makeInvoice(), makeDeps())).rejects.not.toThrow(
      /Check your account mappings/,
    );
  });

  it("DOES append 'Check your account mappings' when the error mentions an account", async () => {
    rpcResult = {
      data: null,
      error: { message: "No Accounts Receivable account is mapped for this business." },
    };

    await expect(confirmInvoiceAndPostGL(makeInvoice(), makeDeps())).rejects.toThrow(
      /Check your account mappings/,
    );
  });

  it("throws when the server returns no success flag", async () => {
    rpcResult = { data: { success: false }, error: null };
    await expect(confirmInvoiceAndPostGL(makeInvoice(), makeDeps())).rejects.toThrow(
      /no success flag/,
    );
  });
});

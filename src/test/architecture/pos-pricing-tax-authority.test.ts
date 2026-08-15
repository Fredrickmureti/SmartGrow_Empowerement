/**
 * POS Wave · Phase 4 architecture guard — pricing & tax authority.
 *
 * Invariants:
 *  1. `pos_resolve_line` delegates to the canonical resolvers instead of
 *     re-deriving price/tax from `products` inside POS.
 *  2. A cart-level server quote (`pos_quote_cart`) exists, is branch-guarded
 *     and is the only source of the money the terminal displays.
 *  3. The terminal fails CLOSED: no tender while the quote is missing/stale.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

function latestDefining(pattern: string): string {
  const out = execSync(`rg -l '${pattern}' supabase/migrations`, { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
  const last = out[out.length - 1];
  if (!last) throw new Error(`no migration defines ${pattern}`);
  return last;
}

describe("POS Phase 4 — pricing & tax are server-authoritative", () => {
  const sqlFile = latestDefining("CREATE OR REPLACE FUNCTION public.pos_resolve_line");
  const sql = readFileSync(sqlFile, "utf8");
  const resolver = sql.slice(sql.lastIndexOf("CREATE OR REPLACE FUNCTION public.pos_resolve_line"));

  it("pos_resolve_line delegates price to resolve_line_unit_price", () => {
    expect(resolver).toMatch(/public\.resolve_line_unit_price\s*\(/);
  });

  it("pos_resolve_line delegates tax to resolve_sales_line_tax", () => {
    expect(resolver).toMatch(/public\.resolve_sales_line_tax\s*\(/);
  });

  it("pos_resolve_line does not read prices straight out of products", () => {
    const body = resolver.slice(0, resolver.indexOf("CREATE OR REPLACE FUNCTION public.pos_quote_cart"));
    expect(body).not.toMatch(/FROM\s+public\.products/i);
  });

  it("pos_quote_cart exists, asserts branch access and reuses pos_resolve_line", () => {
    const quote = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.pos_quote_cart"));
    expect(quote).toMatch(/assert_pos_caller_branch_access\s*\(/);
    expect(quote).toMatch(/public\.pos_resolve_line\s*\(/);
    expect(quote).not.toMatch(/FROM\s+public\.price_list_items/i);
  });

  const adapter = readFileSync("src/hooks/pos/usePOSCartAdapter.ts", "utf8");
  const quoteHook = readFileSync("src/hooks/pos/usePOSCartQuote.ts", "utf8");
  const terminal = readFileSync("src/pages/pos/POSTerminal.tsx", "utf8");

  it("the cart hook calls the server quote RPC", () => {
    expect(quoteHook).toMatch(/pos_quote_cart/);
  });

  it("displayed totals come from the server quote when one exists", () => {
    expect(adapter).toMatch(/quote\s*\n?\s*\?\s*\{[\s\S]*subtotal: quote\.subtotal/);
    expect(adapter).toMatch(/tax_amount: quote\.tax_amount/);
    expect(adapter).toMatch(/total: quote\.total/);
  });

  it("tender fails closed when the quote is not authoritative", () => {
    expect(terminal).toMatch(/!cart\.isPricingAuthoritative/);
    const openTender = terminal.slice(terminal.indexOf("const openTender"));
    expect(openTender.slice(0, 900)).toMatch(/return;/);
  });
});

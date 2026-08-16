/**
 * POS Wave · Phase 7 — payment integrity guards (client side).
 *
 * The server proves the payable total at commit (`pos_payment_session_commit`
 * re-quotes with `pos_quote_cart`). These assertions keep the client honest
 * about the *intent* it must forward, so a legitimate sale never trips the
 * server's fail-closed check and no new client-side money math creeps back in.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("Phase 7 — payment integrity", () => {
  const commit = read("src/hooks/pos/usePOSTransactionOffline.ts");
  const terminal = read("src/pages/pos/POSTerminal.tsx");

  it("forwards the cart-level discount intent in the commit envelope", () => {
    expect(commit).toMatch(/cart_discount_type:\s*data\.cart_discount\?\.type/);
    expect(commit).toMatch(/cart_discount_value:\s*data\.cart_discount\?\.value/);
  });

  it("the terminal supplies the active cart discount to the commit", () => {
    expect(terminal).toMatch(/cart_discount:\s*cart\.cartDiscount/);
  });

  it("still opens the session with the server-quoted total", () => {
    expect(commit).toMatch(/grandTotal:\s*data\.cart\.total/);
  });

  it("only cash tenders carry change", () => {
    expect(commit).toMatch(/change_given:\s*p\.method === "cash"/);
    expect(terminal).toMatch(/change_given:\s*method === "cash"/);
  });

  it("never recomputes tax or line totals for the commit envelope", () => {
    const envelope = commit.slice(commit.indexOf("const envelope = await commitSession"));
    expect(envelope).not.toMatch(/\*\s*item\.(unit_price|tax_rate)/);
  });
});

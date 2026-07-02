/**
 * Architecture guard — POSTerminal.handlePaymentComplete must always carry
 * tendered_amount and change_given through to the RPC payloads and the
 * completedTransaction state. The original 19,000 / 20,000 cash bug was a
 * silent leak in this exact mapping; this test pins the shape forever.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(__dirname, "../../pages/pos/POSTerminal.tsx");

describe("POSTerminal payment mapping", () => {
  const code = readFileSync(SRC, "utf8");

  it("handlePaymentComplete exists", () => {
    expect(code).toMatch(/handlePaymentComplete\s*=/);
  });

  it("forwards tendered_amount and change_given everywhere it builds a payment row", () => {
    // Slice from handlePaymentComplete to the next top-level const/handler.
    const start = code.indexOf("handlePaymentComplete");
    expect(start).toBeGreaterThan(-1);
    const tail = code.slice(start);
    const end = tail.search(/\n\s{2}const\s+\w+\s*=\s*(?:async\s*)?\(/);
    const region = end > -1 ? tail.slice(0, end) : tail;

    // Every "method:" key inside this region (i.e. payment object literal)
    // must be matched by tendered_amount and change_given somewhere in the
    // same handler. Counts must align so no map() variant slips through.
    const methodCount = (region.match(/\bmethod\s*:/g) ?? []).length;
    const tenderedCount = (region.match(/\btendered_amount\s*:/g) ?? []).length;
    const changeCount = (region.match(/\bchange_given\s*:/g) ?? []).length;

    expect(methodCount).toBeGreaterThan(0);
    expect(tenderedCount).toBeGreaterThanOrEqual(methodCount);
    expect(changeCount).toBeGreaterThanOrEqual(methodCount);
  });
});
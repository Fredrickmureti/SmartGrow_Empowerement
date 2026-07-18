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
    // Anchor on the actual declaration, not the first mention (which may be
    // a comment reference higher in the file).
    const declMatch = code.match(/const\s+handlePaymentComplete\s*=/);
    expect(declMatch, "handlePaymentComplete declaration not found").toBeTruthy();
    const start = declMatch!.index!;
    const tail = code.slice(start);
    const end = tail.slice(1).search(/\n\s{2}const\s+\w+\s*=\s*(?:async\s*)?\(/);
    const region = end > -1 ? tail.slice(0, end + 1) : tail;


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
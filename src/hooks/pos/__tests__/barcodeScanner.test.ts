import { describe, it, expect } from "vitest";
import { parseBarcodePayload } from "../useBarcodeScanner";

describe("parseBarcodePayload", () => {
  it("returns qty=1 for a plain barcode", () => {
    expect(parseBarcodePayload("1234567890")).toEqual({
      code: "1234567890",
      quantity: 1,
    });
  });

  it("parses Odoo-style n*<barcode> multiplier", () => {
    expect(parseBarcodePayload("3*1234567890")).toEqual({
      code: "1234567890",
      quantity: 3,
    });
  });

  it("trims whitespace", () => {
    expect(parseBarcodePayload("  5*9990001  ")).toEqual({
      code: "9990001",
      quantity: 5,
    });
  });

  it("rejects multiplier of zero", () => {
    expect(parseBarcodePayload("0*1234")).toEqual({
      code: "0*1234",
      quantity: 1,
    });
  });

  it("rejects unreasonably large multiplier", () => {
    const out = parseBarcodePayload("100000*1234");
    expect(out.quantity).toBe(1);
  });

  it("does not split on a stray asterisk inside the code body", () => {
    // No leading digits-then-* pattern, so treated as the whole code.
    expect(parseBarcodePayload("ABC*123")).toEqual({
      code: "ABC*123",
      quantity: 1,
    });
  });
});

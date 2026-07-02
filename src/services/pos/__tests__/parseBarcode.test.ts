import { describe, it, expect } from "vitest";
import { parseScanPayload } from "../parseBarcode";

describe("parseScanPayload", () => {
  it("returns plain code with qty=1 by default", () => {
    expect(parseScanPayload("5901234123457")).toEqual({
      code: "5901234123457",
      quantity: 1,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseScanPayload("  ABC123  ")).toEqual({ code: "ABC123", quantity: 1 });
  });

  it("parses Odoo-style n*code qty prefix", () => {
    expect(parseScanPayload("3*1234567")).toEqual({ code: "1234567", quantity: 3 });
    expect(parseScanPayload("12*ABC-9")).toEqual({ code: "ABC-9", quantity: 12 });
  });

  it("rejects zero / negative / oversize multipliers", () => {
    expect(parseScanPayload("0*1234567")).toEqual({ code: "0*1234567", quantity: 1 });
    expect(parseScanPayload("99999*1234567")).toEqual({
      code: "99999*1234567",
      quantity: 1,
    });
  });

  it("leaves codes that merely contain * untouched", () => {
    expect(parseScanPayload("AB*CD")).toEqual({ code: "AB*CD", quantity: 1 });
  });

  it("treats empty / whitespace input as empty code", () => {
    expect(parseScanPayload("")).toEqual({ code: "", quantity: 1 });
    expect(parseScanPayload("   ")).toEqual({ code: "", quantity: 1 });
  });
});

/**
 * Entity scan contract — admission rules for handling units and documents.
 */
import { describe, it, expect } from "vitest";
import {
  gateEntityToken,
  entityCodeEquals,
  normalizeEntityCode,
} from "@/features/warehouse/scanning/wmsEntityScan";

describe("gateEntityToken", () => {
  it("admits a site-local opaque LPN", () => {
    const g = gateEntityToken(" lpn-000123 ", "lpn");
    expect(g.refusal).toBeNull();
    expect(g.code).toBe("LPN-000123");
  });

  it("admits an SSCC as a carton and exposes it", () => {
    const g = gateEntityToken("003123456789012345", "carton");
    expect(g.refusal).toBeNull();
    expect(g.sscc).toBe("003123456789012345");
  });

  it("refuses a product barcode at a carton prompt", () => {
    const g = gateEntityToken("05012345678900", "carton");
    expect(g.refusal).toMatch(/product barcode/i);
  });

  it("refuses a pallet label at a gate pass prompt", () => {
    const g = gateEntityToken("003123456789012345", "gate_pass");
    expect(g.refusal).toMatch(/pallet/i);
  });

  it("treats an empty scan as a no-op, not a refusal", () => {
    expect(gateEntityToken("   ", "lpn")).toEqual({ code: "", sscc: null, refusal: null });
  });
});

describe("entity code comparison", () => {
  it("normalises case and whitespace", () => {
    expect(normalizeEntityCode("  ctn-42 ")).toBe("CTN-42");
    expect(entityCodeEquals("ctn-42", " CTN-42 ")).toBe(true);
  });

  it("never matches on empty", () => {
    expect(entityCodeEquals("", "")).toBe(false);
    expect(entityCodeEquals(null, undefined)).toBe(false);
  });
});
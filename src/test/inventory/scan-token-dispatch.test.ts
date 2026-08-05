/**
 * ADR-0110 Phase 7 — scanned-token dispatcher.
 *
 * The classifier decides what kind of thing was scanned before any
 * resolver runs, and only refuses a scan when the token is positively a
 * different kind. Opaque tokens (SKUs, LPNs, document numbers) must stay
 * permissive or every LPN prompt would start rejecting valid scans.
 */
import { describe, it, expect } from "vitest";
import {
  classifyScanToken,
  describeTokenMismatch,
} from "@/lib/scan/classifyScanToken";

const FNC1 = "\u001D";

describe("classifyScanToken", () => {
  it("classifies a GS1 product label as product and exposes lot/expiry", () => {
    const t = classifyScanToken(`0105012345678900${FNC1}10LOT42${FNC1}17261231`);
    expect(t.kind).toBe("product");
    expect(t.resolveCode).toBe("05012345678900");
    expect(t.lot).toBe("LOT42");
    expect(t.expiry?.getUTCFullYear()).toBe(2026);
    expect(t.candidates).toContain("5012345678900");
    expect(t.certain).toBe(true);
  });

  it("classifies a GS1 pallet label as sscc", () => {
    const t = classifyScanToken("00340123451111111111");
    expect(t.kind).toBe("sscc");
    expect(t.resolveCode).toBe("340123451111111111");
    expect(t.certain).toBe(true);
  });

  it("classifies a bare 18-digit code as sscc", () => {
    expect(classifyScanToken("340123451111111111").kind).toBe("sscc");
  });

  it("classifies a GS1 (414) label as a location", () => {
    const t = classifyScanToken("4145012345000013");
    expect(t.kind).toBe("location");
    expect(t.resolveCode).toBe("5012345000013");
  });

  it("classifies bare GTIN widths as product", () => {
    for (const code of ["12345670", "012345678905", "5901234123457", "05012345678900"]) {
      expect(classifyScanToken(code).kind).toBe("product");
    }
  });

  it("classifies segmented position codes as location, but not certainly", () => {
    for (const code of ["A-01-02", "RCV/DOCK/01", "AISLE_3", "A.1.2"]) {
      const t = classifyScanToken(code);
      expect(t.kind).toBe("location");
      expect(t.certain).toBe(false);
    }
  });

  it("leaves SKUs, LPNs and doc numbers opaque", () => {
    for (const code of ["COLA500", "LPN00099123", "SO12345"]) {
      const t = classifyScanToken(code);
      expect(t.kind).toBe("opaque");
      expect(t.certain).toBe(false);
    }
  });

  it("normalises case and whitespace like code_norm", () => {
    expect(classifyScanToken("  cola-500 ").norm).toBe("COLA-500");
    expect(classifyScanToken("   ").kind).toBe("empty");
  });
});

describe("describeTokenMismatch", () => {
  it("refuses a pallet label at an item prompt", () => {
    const msg = describeTokenMismatch(classifyScanToken("340123451111111111"), "product");
    expect(msg).toMatch(/pallet/i);
    expect(msg).toMatch(/product barcode/i);
  });

  it("refuses a product barcode at a bin prompt", () => {
    expect(describeTokenMismatch(classifyScanToken("5901234123457"), "location")).toMatch(
      /position label/i,
    );
  });

  it("accepts the expected kind", () => {
    expect(describeTokenMismatch(classifyScanToken("5901234123457"), "product")).toBeNull();
    expect(describeTokenMismatch(classifyScanToken("A-01-02"), "location")).toBeNull();
  });

  it("never refuses an opaque token — the caller's resolver adjudicates", () => {
    expect(describeTokenMismatch(classifyScanToken("LPN00099123"), "product")).toBeNull();
    expect(describeTokenMismatch(classifyScanToken("COLA500"), "location")).toBeNull();
    expect(describeTokenMismatch(classifyScanToken("A-01-02"), "product")).toBeNull();
  });

  it("never refuses an empty scan", () => {
    expect(describeTokenMismatch(classifyScanToken(""), "product")).toBeNull();
  });
});

describe("dispatcher is wired into the scan gates", () => {
  const read = (p: string) =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("node:fs").readFileSync(require("node:path").resolve(__dirname, "../../", p), "utf-8");

  for (const f of [
    "features/warehouse/scanning/useWmsIdentityGate.ts",
    "features/warehouse/locations/BinScanField.tsx",
  ]) {
    it(`${f} classifies the token before resolving`, () => {
      const src = read(f);
      expect(src).toContain("classifyScanToken");
      expect(src).toContain("describeTokenMismatch");
    });
  }
});

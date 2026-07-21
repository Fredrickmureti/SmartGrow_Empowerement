import { describe, it, expect } from "vitest";
import { compileLabelDoc, type LabelDoc } from "@/services/printing/labelCompiler";

const DOC: LabelDoc = {
  version: 1,
  elements: [
    { id: "t1", type: "text", xMm: 3, yMm: 3, text: "GOODS RECEIVED", fontSize: 5, bold: true },
    { id: "v1", type: "variable", xMm: 3, yMm: 12, token: "grn_id", fontSize: 3 },
    { id: "b1", type: "barcode", xMm: 3, yMm: 22, token: "barcode", symbology: "code128", heightMm: 10 },
  ],
};

describe("labelCompiler", () => {
  it("emits ZPL with no envelope tokens", () => {
    const zpl = compileLabelDoc(DOC, "zpl", 203);
    expect(zpl).toContain("^XA");
    expect(zpl).toContain("^XZ");
    expect(zpl).toContain("GOODS RECEIVED");
    expect(zpl).toContain("{{grn_id}}");
    expect(zpl).toContain("{{barcode}}");
    // Envelope injection is the dispatcher's job (ADR-0087).
    expect(zpl).not.toMatch(/\^PW\d+/);
    expect(zpl).not.toMatch(/\^LL\d+/);
  });

  it("emits EPL2 with no envelope tokens", () => {
    const epl = compileLabelDoc(DOC, "epl", 203);
    expect(epl.startsWith("N")).toBe(true);
    expect(epl).toContain("GOODS RECEIVED");
    expect(epl).toContain("{{grn_id}}");
    expect(epl).not.toMatch(/(^|\n)\s*q\d+/i);
    expect(epl).not.toMatch(/(^|\n)\s*Q\d+,\d+/);
  });

  it("scales geometry with DPI", () => {
    const zpl203 = compileLabelDoc(DOC, "zpl", 203);
    const zpl300 = compileLabelDoc(DOC, "zpl", 300);
    // 3mm at 203dpi ≈ 24 dots, at 300dpi ≈ 35 dots — bodies must differ.
    expect(zpl203).not.toBe(zpl300);
    expect(zpl300).toContain("^FO35,35");
  });

  it("ESC/POS output positions elements (Phase B2 — no more flat concatenation)", () => {
    const bytes = compileLabelDoc(DOC, "escpos", 203);
    // ESC $ nL nH — absolute horizontal position must appear at least once.
    expect(bytes).toMatch(/\x1B\$/);
    // Feed / newline must be present so elements don't stack on the same line.
    expect(bytes.includes("\n") || bytes.includes("\x1BJ")).toBe(true);
    // Content still round-trips through the mustache pass.
    expect(bytes).toContain("{{grn_id}}");
    expect(bytes).toContain("GOODS RECEIVED");
  });

  it("ESC/POS output scales with DPI (Phase B2)", () => {
    const b203 = compileLabelDoc(DOC, "escpos", 203);
    const b300 = compileLabelDoc(DOC, "escpos", 300);
    expect(b203).not.toBe(b300);
  });
});

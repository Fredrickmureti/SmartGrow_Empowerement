/**
 * Phase A.4 — Line-width safety-net regression suite.
 *
 * The receipt builder MUST never emit a printable text line wider than the
 * resolved column count of the printer profile. Any line that would overflow
 * is clamped (with an ellipsis) before the LF byte is written. This test
 * exercises the worst offenders we've observed (long item names, huge SKUs,
 * mega totals, multilingual chars, narrow/40mm paper, columns_override) and
 * asserts every printable line stays within the resolved width.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDocumentEscPos } from "./builder.ts";
import { resolvePrinterProfile } from "../receipt/engine/PrinterProfile.ts";

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

function decodePrintableLines(bytes: Uint8Array): string[] {
  // Strip ESC/GS command sequences and split on LF; the remaining bytes are
  // the actual printable characters in CP858/ASCII so .length == column count.
  const out: number[][] = [[]];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === ESC) {
      // Most ESC commands are 2-3 bytes; 1B 40 (init), 1B 61 a (align),
      // 1B 4D n (font), 1B 21 n (mode), 1B 33 n (line spacing), etc.
      const next = bytes[i + 1];
      if (next === 0x40) { i += 1; continue; }
      if (next === 0x33 || next === 0x4d || next === 0x21 || next === 0x61 ||
          next === 0x45 || next === 0x47 || next === 0x2d || next === 0x74 ||
          next === 0x52) { i += 2; continue; }
      i += 1;
      continue;
    }
    if (b === GS) {
      const next = bytes[i + 1];
      // GS V m / GS V m n (cut), GS ! n (size), GS L nL nH (left margin)
      if (next === 0x56) {
        // could be 2 or 3 byte sequence
        if (bytes[i + 2] === 0x00 || bytes[i + 2] === 0x01) { i += 2; continue; }
        i += 3; continue;
      }
      if (next === 0x21) { i += 2; continue; }
      if (next === 0x4c) { i += 3; continue; }
      i += 1;
      continue;
    }
    if (b === LF) { out.push([]); continue; }
    out[out.length - 1].push(b);
  }
  return out
    .map((row) => row.map((c) => String.fromCharCode(c)).join(""))
    .filter((s) => s.length > 0);
}

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    document_type: "pos_receipt",
    document_type_label: "RECEIPT",
    document_number: "R-9999999",
    issue_date: "2026-05-13",
    status: "PAID",
    currency: "USD",
    subtotal: 9_999_999.99,
    tax_amount: 1_234_567.89,
    total: 11_234_567.88,
    amount_paid: 11_234_567.88,
    organization: { name: "Long Organization Name Llc International" },
    contact: { name: "Walk-in" },
    items: [
      {
        description:
          "Premium Single-Origin Ethiopian Yirgacheffe Whole Bean Coffee 1kg Special",
        quantity: 999,
        unit_price: 1234.56,
        line_total: 1233231.44,
        sku: "PROD-EXTRA-LONG-SKU-IDENTIFIER-001-VARIANT-A-2026",
        tax_rate: 16,
      },
      {
        description: "Short item",
        quantity: 1,
        unit_price: 1.0,
        line_total: 1.0,
        sku: "S-1",
      },
    ],
    notes: "Thanks for shopping with us — visit https://example.com/very/long/url",
    ...overrides,
  } as any;
}

for (const paper of ["40mm", "58mm", "80mm"] as const) {
  for (const font of ["A", "B"] as const) {
    Deno.test(`line-width clamp — ${paper} font ${font}`, () => {
      const profile = resolvePrinterProfile({ paper, font });
      const bytes = buildDocumentEscPos(makeDoc(), {
        width: paper,
        font,
        receiptSettings: { paper_size: paper, font_size: font === "B" ? "small" : "medium" } as any,
      });
      const lines = decodePrintableLines(bytes);
      assert(lines.length > 0, "builder produced zero lines");
      // Phase A.6 — zero tolerance. Margins are applied exactly once and
      // every printable line MUST fit within the resolved physical column
      // count of the printer profile.
      for (const line of lines) {
        assert(
          line.length <= profile.columns,
          `line "${line}" (len=${line.length}) exceeds profile.columns=${profile.columns} for ${paper}/${font}`,
        );
      }
    });
  }
}

Deno.test("line-width clamp — printer columns_override (42 cols on 80mm)", () => {
  const bytes = buildDocumentEscPos(makeDoc(), {
    width: "80mm",
    font: "A",
    receiptSettings: { paper_size: "80mm" } as any,
    capabilities: { columns_override: 42 },
  });
  const lines = decodePrintableLines(bytes);
  for (const line of lines) {
    assert(
      line.length <= 42,
      `line "${line}" (len=${line.length}) > columns_override=42`,
    );
  }
});

Deno.test("line-width clamp — narrow 40mm with margin_cols=2", () => {
  const profile = resolvePrinterProfile({ paper: "40mm", font: "A", marginCols: 2 });
  assertEquals(profile.columns, 24);
  const bytes = buildDocumentEscPos(makeDoc(), {
    width: "40mm",
    receiptSettings: { paper_size: "40mm", margin_cols: 2 } as any,
  });
  const lines = decodePrintableLines(bytes);
  for (const line of lines) {
    assert(
      line.length <= 24,
      `40mm line "${line}" (len=${line.length}) > 24 cols`,
    );
  }
});

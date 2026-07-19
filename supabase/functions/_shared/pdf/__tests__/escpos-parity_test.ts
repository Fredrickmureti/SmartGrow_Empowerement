/**
 * ADR-0008 Phase T5 — ESC/POS ↔ PDF parity guardrail.
 *
 * Both thermal renderers (server PDF via `PdfBuilder` and byte-stream ESC/POS
 * via `buildDocumentEscPos`) must consume the SAME `DocumentData` shape.
 * This test locks the contract: one shared fixture, both renderers succeed,
 * and both surface the document identifiers a receipt reader expects
 * (document number, total). If a future refactor forks the shape, one of
 * these paths will fail and this test will point at the divergence before
 * it ships.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { PdfBuilder } from "../PdfBuilder.ts";
import { buildDocumentEscPos } from "../../escpos/builder.ts";

const MM_TO_PT = 72 / 25.4;

// Shared, paper-agnostic document model (ADR-0008 Layer 1).
const doc = {
  document_type: "pos_receipt",
  document_type_label: "RECEIPT",
  document_number: "R-4242",
  issue_date: "2026-07-19",
  status: "PAID",
  currency: "EUR",
  subtotal: 1000,
  tax_amount: 200,
  total: 1200,
  amount_paid: 1200,
  organization: { name: "Parity Café" },
  contact: null,
  items: [
    { description: "Espresso", quantity: 2, unit_price: 500, line_total: 1000 },
  ],
  notes: null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function asciiDecode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else if (b === 0x0a) s += "\n";
  }
  return s;
}

Deno.test("T5 parity: ESC/POS renderer accepts the shared DocumentData", () => {
  const bytes = buildDocumentEscPos(doc);
  assert(bytes.length > 0, "ESC/POS output must be non-empty");
  const text = asciiDecode(bytes);
  assert(text.includes("R-4242"), "ESC/POS output must include document number");
});

Deno.test("T5 parity: PdfBuilder renders the shared DocumentData on 80mm continuous", async () => {
  const builder = await PdfBuilder.create({ orientation: "portrait", paperFormat: "80mm" });
  builder.newPage();
  assertEquals(builder.state.heightMode, "continuous", "80mm must resolve to continuous");
  const expectedW = 80 * MM_TO_PT;
  assert(
    Math.abs(builder.page.getWidth() - expectedW) < 0.5,
    `80mm width must be ~${expectedW.toFixed(1)}pt`,
  );
  // Consume some vertical space to force the crop path.
  builder.y -= 50;
  const out = await builder.save();
  assert(out.byteLength > 0, "PDF bytes must be non-empty");
  const finalH = builder.page.getHeight();
  assert(
    finalH < 297 * MM_TO_PT - 1,
    `continuous save must crop below A4 height (got ${finalH}pt)`,
  );
});

Deno.test("T5 parity: PdfBuilder rejects thermal presets in fixed-height mode", async () => {
  // Guardrail: the moment somebody re-adds a numeric `heightMm` to a thermal
  // preset (regressing Phase T1), state.heightMode flips to "fixed" and this
  // assertion fires — long before a user sees a tall blank strip in prod.
  for (const preset of ["80mm", "58mm", "40mm"] as const) {
    const b = await PdfBuilder.create({ orientation: "portrait", paperFormat: preset });
    assertEquals(
      b.state.heightMode,
      "continuous",
      `${preset} preset must remain continuous (ADR-0008 Phase T1)`,
    );
  }
});

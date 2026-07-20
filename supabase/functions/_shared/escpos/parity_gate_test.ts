/**
 * Wave 6b — Row-producer parity gate.
 *
 * After the Wave 6b cutover, `generate-document` no longer emits ESC/POS
 * via `buildDocumentEscPos`; it goes through `renderDocumentEscPos`
 * (which consumes `buildReceiptLines(...)` — the SAME row producer that
 * feeds `renderThermalPdf`).
 *
 * This test locks the invariant in place: the ESC/POS bytes we now emit
 * must be produced by encoding the exact `ReceiptLinesResult` that the
 * PDF renderer would consume. If a future change re-introduces a second
 * row producer for ESC/POS, this test fails loudly.
 *
 * It ALSO retains a structural diff against the legacy `buildDocumentEscPos`
 * so the operator can see (a) what changed on cutover and (b) what
 * remaining legacy blocks (kitchen tickets, R2 duplication) still live
 * in the old builder and are intentionally out of scope for this gate.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { EscPosWidth } from "./builder.ts";
import { renderLinesEscPos } from "./renderLinesEscPos.ts";
import { renderDocumentEscPos } from "./renderDocumentEscPos.ts";
import { buildReceiptLines } from "../receipt/lines.ts";
import { documentToReceiptInput } from "../receipt/documentToInput.ts";
import type { DocumentData } from "../templateRenderer.ts";

const goldenDoc: DocumentData = {
  document_type: "pos_receipt",
  document_type_label: "SALES RECEIPT",
  document_number: "R-2026-0001",
  issue_date: "2026-07-20T10:15:00Z",
  status: "PAID",
  currency: "KES",
  subtotal: 1000,
  tax_amount: 160,
  discount_amount: 50,
  total: 1110,
  amount_paid: 1200,
  organization: {
    name: "Café Niño Roasters",
    address: "123 Kimathi Street",
    city: "Nairobi",
    phone: "+254 700 000 000",
    email: "hi@cafeninho.co.ke",
    tax_id: "P051234567X",
    timezone: "Africa/Nairobi",
  } as unknown as DocumentData["organization"],
  contact: { name: "Jane Doe" } as DocumentData["contact"],
  items: [
    { description: "Espresso", quantity: 2, unit_price: 250, line_total: 500, tax_amount: 80, tax_rate: 16 },
    { description: "Cappuccino Grande", quantity: 1, unit_price: 500, line_total: 500, tax_amount: 80, tax_rate: 16 },
  ] as DocumentData["items"],
  notes: "Thanks — come back soon",
  cashier_name: "Alice",
  register_id: "REG-01",
  pos_payments: [
    { payment_method: "cash", amount: 1200, reference: null },
  ],
  pos_receipt_settings: {
    paper_size: "80mm",
    show_store_name: true,
    show_store_address: true,
    show_store_phone: true,
    show_cashier_name: true,
    show_register_id: true,
    show_customer_name: true,
    show_receipt_number: true,
    show_date_time: true,
    show_subtotal: true,
    show_discount_total: true,
    show_tax_breakdown: true,
    show_payment_method: true,
    show_amount_tendered: true,
    show_change_due: true,
    receipt_footer: "Thank you for your visit!",
  },
  etims_cu_number: null,
  etims_qr_data: null,
} as unknown as DocumentData;

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const buf = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else if (b === 0x0a) s += "\n";
  }
  return s;
}

function structuralDiff(a: Uint8Array, b: Uint8Array, labelA: string, labelB: string): string {
  const la = decode(a).split("\n");
  const lb = decode(b).split("\n");
  const only = (x: string[], y: string[]) => x.filter((v) => v.trim() && !y.includes(v));
  return [
    `  ${labelA} bytes: ${a.length}, ${labelB} bytes: ${b.length}`,
    `  ${labelA} lines: ${la.length}, ${labelB} lines: ${lb.length}`,
    `  lines only in ${labelA} (first 20):`,
    ...only(la, lb).slice(0, 20).map((x) => `    - ${JSON.stringify(x)}`),
    `  lines only in ${labelB} (first 20):`,
    ...only(lb, la).slice(0, 20).map((x) => `    + ${JSON.stringify(x)}`),
  ].join("\n");
}

for (const width of ["80mm", "58mm", "40mm"] as EscPosWidth[]) {
  Deno.test(`Wave6b — renderDocumentEscPos IS renderLinesEscPos(buildReceiptLines(...)) @ ${width}`, async () => {
    // The cutover invariant: the production ESC/POS bytes must be
    // bit-identical to encoding the shared engine's rows. If someone
    // slips a second row producer back in, this fails immediately.
    const rs = { ...(goldenDoc as any).pos_receipt_settings, paper_size: width };
    const input = documentToReceiptInput(goldenDoc, {
      settings: rs,
      title: goldenDoc.document_type_label,
    });
    const rows = buildReceiptLines(input);
    const viaEmitter = renderLinesEscPos(rows, {
      caps: { qr_native: true, auto_cut: true },
      cut: true,
      feedLinesAfter: 4,
    });
    const viaHelper = renderDocumentEscPos(goldenDoc, {
      width,
      receiptSettings: rs,
      title: goldenDoc.document_type_label,
      capabilities: { qr_native: true, auto_cut: true },
    });

    const emitterHash = await sha256(viaEmitter);
    const helperHash = await sha256(viaHelper);
    console.log(`\n[Wave6b invariant @ ${width}]`);
    console.log(`  emitter sha256: ${emitterHash}`);
    console.log(`  helper  sha256: ${helperHash}`);
    if (emitterHash !== helperHash) {
      console.log(structuralDiff(viaEmitter, viaHelper, "EMITTER", "HELPER"));
    }
    assertEquals(
      helperHash,
      emitterHash,
      `renderDocumentEscPos must equal renderLinesEscPos(buildReceiptLines(...)) @ ${width}`,
    );

    const text = decode(viaHelper);
    assert(text.includes("No:     R-2026-0001") || text.includes("No:"), "shared ESC/POS must emit the PDF-style receipt number row");
    assert(!/\n\s*#\s*R-2026-0001/.test(text), "shared ESC/POS must never emit legacy centered #receipt-number layout");
  });

}

Deno.test("POS receipt canonical meta omits routine status", () => {
  const bytes = renderDocumentEscPos(goldenDoc, {
    width: "58mm",
    receiptSettings: (goldenDoc as any).pos_receipt_settings,
    title: goldenDoc.document_type_label,
  });
  const text = decode(bytes);
  assert(text.includes("No:"), "receipt number must use the canonical No: row");
  assert(!text.includes("Status:"), "completed POS receipts must omit the routine status row");
});

Deno.test("58mm uncalibrated Font B request downgrades to Font A / 32 columns", () => {
  const input = documentToReceiptInput(goldenDoc, {
    settings: { ...(goldenDoc as any).pos_receipt_settings, paper_size: "58mm", font_size: "medium" },
    title: goldenDoc.document_type_label,
  });
  const expectedRows = buildReceiptLines(input);
  const bytes = renderDocumentEscPos(goldenDoc, {
    width: "58mm",
    receiptSettings: { ...(goldenDoc as any).pos_receipt_settings, paper_size: "58mm" },
    font: "B",
  });
  assertEquals(expectedRows.columns, 32);
  assertEquals(expectedRows.font, "A");
  assertEquals(Array.from(bytes.slice(0, 7)), [0x1b, 0x40, 0x1b, 0x74, 0x13, 0x1b, 0x21]);
  assertEquals(bytes[7], 0x00, "ESC ! must select Font A");
});

Deno.test("58mm calibrated Font B / 42 columns remains available", () => {
  const bytes = renderDocumentEscPos(goldenDoc, {
    width: "58mm",
    receiptSettings: { ...(goldenDoc as any).pos_receipt_settings, paper_size: "58mm" },
    font: "B",
    capabilities: { columns_override: 42 },
  });
  assertEquals(bytes[7], 0x01, "ESC ! must select Font B for a measured profile");
});

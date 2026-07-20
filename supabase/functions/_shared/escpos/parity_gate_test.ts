/**
 * Wave 6b — Byte-parity gate between the legacy `buildDocumentEscPos`
 * (procedural block emitters) and the shared engine path
 * `renderLinesEscPos(buildReceiptLines(documentToReceiptInput(doc)))`.
 *
 * Purpose (enterprise handoff artifact):
 *   Quantifies exactly which sections the shared row-producer still needs
 *   to cover before we can safely retire the legacy builder body. Runs
 *   the same fixture through both paths at 80mm / 58mm / 40mm, computes
 *   a SHA-256 fingerprint, and emits a structural diff report to stdout.
 *
 * Status while Wave 6b is in progress:
 *   The tests DO NOT assert byte-equality yet — that would fail loudly
 *   because the shared engine is missing: fiscal_block, notes/terms,
 *   payment_allocations, refund_banner, copies+cut policy, code128
 *   barcode, per-payment reference lines, cashier/register labels, and
 *   the R2 "copies" duplication logic. Instead the tests fingerprint
 *   both outputs and PRINT a diff summary. When the shared engine
 *   reaches parity, flip `EXPECT_PARITY` to true — the assertions will
 *   then guard the swap.
 */

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDocumentEscPos, type EscPosWidth } from "./builder.ts";
import { renderLinesEscPos } from "./renderLinesEscPos.ts";
import { buildReceiptLines } from "../receipt/lines.ts";
import { documentToReceiptInput } from "../receipt/documentToInput.ts";
import type { DocumentData } from "../templateRenderer.ts";

const EXPECT_PARITY = false; // Flip to true once the shared engine covers every block.

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

function structuralDiff(legacy: Uint8Array, shim: Uint8Array): string {
  const l = decode(legacy).split("\n");
  const s = decode(shim).split("\n");
  const only = (a: string[], b: string[]) =>
    a.filter((x) => x.trim() && !b.includes(x));
  const onlyLegacy = only(l, s).slice(0, 20);
  const onlyShim = only(s, l).slice(0, 20);
  return [
    `  legacy bytes: ${legacy.length}, shim bytes: ${shim.length}`,
    `  legacy lines: ${l.length}, shim lines: ${s.length}`,
    `  lines only in LEGACY (first 20):`,
    ...onlyLegacy.map((x) => `    - ${JSON.stringify(x)}`),
    `  lines only in SHIM (first 20):`,
    ...onlyShim.map((x) => `    + ${JSON.stringify(x)}`),
  ].join("\n");
}

for (const width of ["80mm", "58mm", "40mm"] as EscPosWidth[]) {
  Deno.test(`Wave6b parity gate @ ${width}`, async () => {
    const legacy = buildDocumentEscPos(goldenDoc, { width });
    const input = documentToReceiptInput(goldenDoc);
    // Force the paper width for the shared engine to match the fixture axis.
    (input.settings as Record<string, unknown>).paper_size = width;
    const rows = buildReceiptLines(input);
    const shim = renderLinesEscPos(rows, {
      caps: { qr_native: true, auto_cut: true },
      cut: true,
      feedLinesAfter: 4,
    });

    const legacyHash = await sha256(legacy);
    const shimHash = await sha256(shim);

    console.log(`\n[Wave6b parity @ ${width}]`);
    console.log(`  legacy sha256: ${legacyHash}`);
    console.log(`  shim   sha256: ${shimHash}`);
    console.log(structuralDiff(legacy, shim));

    if (EXPECT_PARITY) {
      assert(
        legacyHash === shimHash,
        `byte-parity failure @ ${width}: legacy=${legacyHash} shim=${shimHash}`,
      );
    } else {
      // While the port is in progress, only assert the shim produced
      // *some* output — the diff above documents the remaining gap.
      assert(shim.length > 32, "shim produced no output");
    }
  });
}
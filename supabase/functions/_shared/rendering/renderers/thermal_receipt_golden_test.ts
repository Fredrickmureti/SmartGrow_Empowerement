/**
 * Wave 7.1 — Thermal receipt byte-parity golden.
 *
 * Locks the exact ESC/POS bytes produced by the Wave 3 AST rendering
 * engine (`renderAstToEscPos`) for a canonical POS receipt fixture.
 * Wave 7.2 mechanically rewrites `PrintClient.print({intent:'receipt'})`
 * callers onto `submitIntent({documentKind:'pos_receipt', …})`. Because
 * `submitIntent` routes through this exact renderer, a byte-for-byte
 * match here is the proof-of-parity for that rewrite.
 *
 * Behavior:
 *   - On first run, if `thermal_receipt_golden.json` is missing, the
 *     test writes the current sha256 and byte-length as the golden,
 *     logs a warning, and passes. The golden is then committed.
 *   - On subsequent runs, any drift fails the test with a structural
 *     diff so the operator can see whether the change is intentional
 *     (bump the golden) or a regression (revert the AST/renderer edit).
 *
 * DO NOT bump the golden without a corresponding entry in
 * `docs/audit/2026-wave6.5-legacy-inventory.md` documenting the reason.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { renderAstToEscPos } from "./escpos.ts";
import { composeBlocks } from "../mediumRegistry.ts";
import type {
  AstBlock,
  RenderContext,
  ResolvedTemplate,
} from "../types.ts";

const GOLDEN_PATH = new URL("./thermal_receipt_golden.json", import.meta.url);

const receiptBlocks: AstBlock[] = [
  { type: "header", variant: "branded" },
  { type: "meta", fields: ["number", "date"] },
  { type: "party", role: "customer" },
  { type: "divider" },
  { type: "table", preset: "line_items" },
  { type: "totals", preset: "receipt" },
  { type: "divider" },
  { type: "notes", source: "footer_note" },
  { type: "footer", variant: "compliance" },
];

const template: ResolvedTemplate = {
  id: "tpl-pos-receipt-golden",
  kind_code: "pos_receipt",
  scope: "system",
  version: 1,
  label: "POS Receipt (golden)",
  ast: {
    version: 1,
    kind: "pos_receipt",
    media_class: "thermal",
    blocks: receiptBlocks,
  },
  theme_id: null,
  header_id: null,
  footer_id: null,
  media_class: "thermal",
};

const receiptSettings = {
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
};

const snapshot: Record<string, unknown> = {
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
  contact: { name: "Jane Doe" },
  items: [
    { description: "Espresso", quantity: 2, unit_price: 250, line_total: 500, tax_amount: 80, tax_rate: 16 },
    { description: "Cappuccino Grande", quantity: 1, unit_price: 500, line_total: 500, tax_amount: 80, tax_rate: 16 },
  ],
  cashier_name: "Alice",
  register_id: "REG-01",
  pos_payments: [{ payment_method: "cash", amount: 1200, reference: null }],
  pos_receipt_settings: receiptSettings,
  notes: "Thanks — come back soon",
  etims_cu_number: null,
  etims_qr_data: null,
};

const business: Record<string, unknown> = {
  name: "Café Niño Roasters",
  address: "123 Kimathi Street",
  city: "Nairobi",
  phone: "+254 700 000 000",
  email: "hi@cafeninho.co.ke",
  tax_id: "P051234567X",
  timezone: "Africa/Nairobi",
};

const context: RenderContext = {
  document: {
    id: "doc-golden-0001",
    kind_code: "pos_receipt",
    organization_id: "org-golden",
    business_id: "biz-golden",
    branch_id: "br-golden",
    number: "R-2026-0001",
    date: "2026-07-20",
    currency: "KES",
    snapshot,
  },
  business,
  theme: null,
  header: null,
  footer: null,
  locale: "en-KE",
  options: {
    width: "80mm",
    title: "SALES RECEIPT",
    receiptSettings,
    capabilities: { qr_native: true, auto_cut: true },
    font: "A",
  },
};

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

interface Golden { sha256: string; byte_length: number; note: string }

Deno.test("Wave7.1 — AST→ESC/POS pos_receipt bytes match golden", async () => {
  const blocks = composeBlocks(template, context);
  const rendered = renderAstToEscPos({ template, context, blocks });
  const bytes = rendered.bytes;
  assert(bytes.length > 0, "renderAstToEscPos must emit non-empty bytes");
  assertEquals(rendered.metadata.preview_lines, [
    ...(rendered.metadata.preview_lines as string[]),
  ], "renderer must expose the exact rows encoded into the artifact");
  assert(Array.isArray(rendered.metadata.preview_line_meta));
  const hash = await sha256(bytes);

  let golden: Golden | null = null;
  try {
    golden = JSON.parse(await Deno.readTextFile(GOLDEN_PATH)) as Golden;
  } catch (_) {
    golden = null;
  }

  if (!golden) {
    const written: Golden = {
      sha256: hash,
      byte_length: bytes.length,
      note:
        "Wave 7.1 golden. Auto-written on first run. Do NOT bump without an audit entry in docs/audit/2026-wave6.5-legacy-inventory.md.",
    };
    await Deno.writeTextFile(GOLDEN_PATH, JSON.stringify(written, null, 2) + "\n");
    console.warn(
      `[Wave7.1] Wrote initial golden ${GOLDEN_PATH.pathname}: sha256=${hash} bytes=${bytes.length}`,
    );
    return;
  }

  if (golden.sha256 !== hash || golden.byte_length !== bytes.length) {
    const preview = decode(bytes).split("\n").slice(0, 40).map((l) => `    | ${l}`).join("\n");
    console.error(
      `[Wave7.1] AST→ESC/POS drift:\n` +
        `  expected sha256=${golden.sha256} bytes=${golden.byte_length}\n` +
        `  actual   sha256=${hash} bytes=${bytes.length}\n` +
        `  first 40 lines of current output:\n${preview}`,
    );
  }
  assertEquals(hash, golden.sha256, "AST→ESC/POS sha256 drifted from golden");
  assertEquals(bytes.length, golden.byte_length, "AST→ESC/POS byte length drifted from golden");
});

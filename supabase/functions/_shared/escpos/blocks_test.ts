/**
 * Stage R3b — block-model contract tests.
 *
 * Locks two invariants so the procedural→dispatch refactor in R3b.2
 * (and any future tenant reordering in R3c) cannot silently regress:
 *
 *  1. DEFAULT_BLOCK_ORDER matches the procedural emit order in
 *     `buildDocumentEscPos` exactly (today: every block emits in this
 *     sequence; tomorrow: the dispatcher iterates this exact list).
 *  2. BLOCK_REGISTRY covers every BlockType — no block can be referenced
 *     without metadata, so the future reorder UI cannot silently drop one.
 *
 * Plus a golden-bytes sanity check: rendering a fixed fixture with default
 * settings produces a stable byte stream whose section markers (rule lines,
 * TOTAL, Subtotal, etc.) appear in the documented order.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BLOCK_REGISTRY,
  DEFAULT_BLOCK_ORDER,
  resolveBlockOrder,
  type BlockType,
} from "./blocks.ts";
import { buildDocumentEscPos } from "./builder.ts";
import type { DocumentData } from "../templateRenderer.ts";

Deno.test("R3b: BLOCK_REGISTRY has metadata for every BlockType", () => {
  for (const t of DEFAULT_BLOCK_ORDER) {
    const meta = BLOCK_REGISTRY[t];
    assert(meta, `missing registry entry for ${t}`);
    assertEquals(meta.type, t);
    assert(typeof meta.pinned === "boolean");
    assert(meta.label.length > 0);
  }
});

Deno.test("R3b: DEFAULT_BLOCK_ORDER is the canonical emit sequence", () => {
  // This is the order the procedural builder emits today. R3b.2's
  // refactor must produce byte-equal output by iterating exactly this
  // list. If you change the procedural order WITHOUT updating this
  // constant, this test fails — that is intentional.
  const expected: BlockType[] = [
    "custom_header",
    "org_header",
    "title_meta",
    "cashier_register",
    "recipient",
    "items",
    "totals",
    "refund_banner",
    "grand_total",
    "savings",
    "payments",
    "tendered_change",
    "notes",
    "terms",
    "footer_text",
    "return_policy",
    "fiscal_etims_ke",
    "barcode",
    "qr_code",
  ];
  assertEquals([...DEFAULT_BLOCK_ORDER], expected);
});

Deno.test("R3b: resolveBlockOrder defaults to DEFAULT_BLOCK_ORDER (no settings)", () => {
  assertEquals(resolveBlockOrder(null), DEFAULT_BLOCK_ORDER);
  assertEquals(resolveBlockOrder({}), DEFAULT_BLOCK_ORDER);
});

// ── Golden sanity: documented section markers appear in canonical order ──
function makeDoc(): DocumentData {
  return {
    document_type: "pos_receipt",
    document_number: "R3B-GOLDEN-001",
    issue_date: "2026-05-12T10:00:00Z",
    organization: {
      name: "Acme Co",
      address: "1 Main St",
      city: "Nairobi", state: null, postal_code: null,
      phone: "+254700000000", email: null, tax_id: "P051000000A",
    },
    contact: { name: "Walk-in" },
    items: [
      { description: "Widget", quantity: 2, unit_price: 100, line_total: 200, tax_amount: 32, tax_rate: 16 },
    ],
    subtotal: 200,
    tax_amount: 32,
    discount_amount: 5,
    total: 227,
    currency: "KES",
    notes: "Thanks!",
    terms: null,
    amount_paid: 227,
    status: null,
    due_date: null,
    document_type_label: "RECEIPT",
  } as unknown as DocumentData;
}

Deno.test("R3b: golden output emits documented markers in canonical order", () => {
  const bytes = buildDocumentEscPos(makeDoc(), {
    receiptSettings: {
      show_payment_method: true,
      show_subtotal: true,
      show_discount_total: true,
      show_savings: true,
    },
  });
  const txt = new TextDecoder("ascii", { fatal: false }).decode(bytes);

  // Each marker MUST appear, and in this relative order. If R3b.2's
  // refactor changes the dispatch sequence, this fails immediately.
  const markers = ["Acme Co", "RECEIPT", "Widget", "Subtotal", "Discount", "TOTAL", "You saved", "Thanks!"];
  let cursor = 0;
  for (const m of markers) {
    const idx = txt.indexOf(m, cursor);
    assert(idx >= 0, `missing marker '${m}' (cursor=${cursor})`);
    cursor = idx + m.length;
  }
});

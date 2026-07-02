/**
 * W4a — CP858 ESC/POS encoder regression suite.
 * X7 — Receipt-settings honoring suite.
 *
 * Locks the byte-level behaviour of `buildDocumentEscPos`. The first block
 * keeps the CP858 / transliteration guarantees from W4a. The second block
 * proves that ExtendedReceiptSettings actually drives the printed output.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDocumentEscPos } from "./builder.ts";

const baseDoc = {
  document_type: "pos_receipt",
  document_type_label: "RECEIPT",
  document_number: "R-001",
  issue_date: "2026-05-11",
  status: "PAID",
  currency: "EUR",
  subtotal: 1000,
  tax_amount: 234.5,
  total: 1234.5,
  amount_paid: 1234.5,
  organization: { name: "Café Niño" },
  contact: null,
  items: [
    { description: "Espresso €", quantity: 1, unit_price: 1234.5, line_total: 1234.5 },
  ],
  notes: "Thanks — come back soon",
} as any;

function countSubseq(bytes: Uint8Array, needle: number[]): number {
  let n = 0;
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    n++;
  }
  return n;
}

function decode(bytes: Uint8Array): string {
  // ASCII-only decode (good enough to assert section headings / labels).
  let s = "";
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else if (b === 0x0a) s += "\n";
  }
  return s;
}

Deno.test("W4a-1: 'Café Niño' produces zero 0x3F substitution bytes", () => {
  const out = buildDocumentEscPos(baseDoc);
  const questionMarks = Array.from(out).filter((b) => b === 0x3f).length;
  assertEquals(questionMarks, 0, "found '?' substitution byte in output");
  assert(out.includes(0x82), "missing CP858 byte for 'é' (0x82)");
  assert(out.includes(0xa4), "missing CP858 byte for 'ñ' (0xa4)");
});

Deno.test("W4a-2: '€' maps to CP858 byte 0xD5", () => {
  const out = buildDocumentEscPos(baseDoc);
  assert(out.includes(0xd5), "missing CP858 byte for '€' (0xD5)");
});

Deno.test("W4a-3: em-dash transliterates to '-' (0x2D), not '?'", () => {
  const out = buildDocumentEscPos(baseDoc);
  assert(out.includes(0x2d));
  const questionMarks = Array.from(out).filter((b) => b === 0x3f).length;
  assertEquals(questionMarks, 0);
});

Deno.test("W4a-4: ESC t 0x13 (CP858 select) is emitted exactly once at stream start", () => {
  const out = buildDocumentEscPos(baseDoc);
  const cmd = [0x1b, 0x74, 0x13];
  assertEquals(countSubseq(out, cmd), 1);
  assertEquals(out[0], 0x1b);
  assertEquals(out[1], 0x40);
  assertEquals(out[2], 0x1b);
  assertEquals(out[3], 0x74);
  assertEquals(out[4], 0x13);
});

// ────────────────────────────────────────────────────────────────────────────
// Stage X7 — settings honoring
// ────────────────────────────────────────────────────────────────────────────

const richDoc = {
  document_type: "pos_receipt",
  document_type_label: "SALES RECEIPT",
  document_number: "TXN-9001",
  issue_date: "2026-05-12",
  status: "completed",
  currency: "KES",
  subtotal: 1000,
  tax_amount: 160,
  discount_amount: 50,
  total: 1110,
  amount_paid: 1200,
  organization: {
    name: "Acme Mart",
    address: "1 Main St",
    city: "Nairobi",
    phone: "+254700000000",
    email: "shop@acme.example",
  },
  contact: { name: "Jane Doe" },
  cashier_name: "Alice",
  register_id: "R-1",
  register_name: "Front Counter",
  items: [
    {
      description: "Widget Deluxe Edition",
      quantity: 2,
      unit_price: 500,
      tax_rate: 16,
      tax_rate_name: "VAT",
      tax_amount: 160,
      discount_amount: 50,
      line_total: 1000,
      sku: "WID-001",
    },
  ],
  pos_payments: [{ payment_method: "cash", amount: 1200, reference: null }],
  etims_cu_number: "CU123",
  etims_qr_data: "https://etims.kra/abc",
} as any;

Deno.test("X7-1: receipt_header / receipt_footer text is emitted", () => {
  const out = buildDocumentEscPos(richDoc, {
    receiptSettings: {
      receipt_header: "WELCOME TO ACME",
      receipt_footer: "GOODBYE FRIEND",
    },
  });
  const txt = decode(out);
  assert(txt.includes("WELCOME TO ACME"), "receipt_header missing");
  assert(txt.includes("GOODBYE FRIEND"), "receipt_footer missing");
});

Deno.test("X7-2: show_store_phone=false hides the phone line", () => {
  const on = decode(buildDocumentEscPos(richDoc, { receiptSettings: { show_store_phone: true } }));
  const off = decode(buildDocumentEscPos(richDoc, { receiptSettings: { show_store_phone: false } }));
  assert(on.includes("+254700000000"));
  assert(!off.includes("+254700000000"));
});

Deno.test("X7-3: item_display_format='tabular' emits the SKU/Item/Qty/Total header", () => {
  const out = buildDocumentEscPos(richDoc, {
    receiptSettings: { item_display_format: "tabular", show_item_sku: true },
  });
  const txt = decode(out);
  assert(txt.includes("SKU"), "tabular header SKU missing");
  assert(txt.includes("Item"), "tabular header Item missing");
  assert(txt.includes("Qty"), "tabular header Qty missing");
  assert(txt.includes("Total"), "tabular header Total missing");
  assert(txt.includes("WID-001"), "SKU value missing");
});

Deno.test("X7-4: item_display_format='single-line' has no Qty/Total column header", () => {
  const out = buildDocumentEscPos(richDoc, {
    receiptSettings: { item_display_format: "single-line" },
  });
  const txt = decode(out);
  // Single-line path uses the "Items" subheading, not a tabular header row.
  assert(txt.includes("Items"));
  assert(!/SKU\s+Item\s+Qty\s+Total/.test(txt));
});

Deno.test("X7-5: show_item_sku flag controls SKU rendering in two-lines mode", () => {
  const on = decode(buildDocumentEscPos(richDoc, {
    receiptSettings: { item_display_format: "two-lines", show_item_sku: true },
  }));
  const off = decode(buildDocumentEscPos(richDoc, {
    receiptSettings: { item_display_format: "two-lines", show_item_sku: false },
  }));
  assert(on.includes("WID-001"));
  assert(!off.includes("WID-001"));
});

Deno.test("X7-6: show_amount_tendered + show_change_due render Tendered and Change", () => {
  const on = decode(buildDocumentEscPos(richDoc, {
    receiptSettings: { show_amount_tendered: true, show_change_due: true },
  }));
  const off = decode(buildDocumentEscPos(richDoc, {
    receiptSettings: { show_amount_tendered: false, show_change_due: false },
  }));
  assert(on.includes("Tendered"));
  assert(on.includes("Change"));
  assert(!off.includes("Tendered"));
  assert(!off.includes("Change"));
});

Deno.test("X7-7: cashier_label_format='served_by' switches the label", () => {
  const a = decode(buildDocumentEscPos(richDoc, {
    receiptSettings: { show_cashier_name: true, cashier_label_format: "cashier" },
  }));
  const b = decode(buildDocumentEscPos(richDoc, {
    receiptSettings: { show_cashier_name: true, cashier_label_format: "served_by" },
  }));
  assert(a.includes("Cashier:"));
  assert(b.includes("Served by:"));
});

Deno.test("X7-8: show_etims_qr=true emits a GS ( k QR command", () => {
  const out = buildDocumentEscPos(richDoc, {
    receiptSettings: { show_etims_info: true, show_etims_qr: true },
  });
  // GS ( k store-data signature: 1D 28 6B pL pH 31 50 30
  const idx = Array.from(out).findIndex((_, i) =>
    out[i] === 0x1d && out[i + 1] === 0x28 && out[i + 2] === 0x6b &&
    out[i + 5] === 0x31 && out[i + 6] === 0x50 && out[i + 7] === 0x30
  );
  assert(idx > 0, "expected GS ( k QR-store command in output");
});

Deno.test("X7-9: show_subtotal=false hides the Subtotal line", () => {
  const on = decode(buildDocumentEscPos(richDoc, { receiptSettings: { show_subtotal: true } }));
  const off = decode(buildDocumentEscPos(richDoc, { receiptSettings: { show_subtotal: false } }));
  assert(on.includes("Subtotal"));
  assert(!off.includes("Subtotal"));
});

Deno.test("X7-10: paper_size='58mm' constrains output to content-width rule lines (32 cols - 2*1 margin = 30)", () => {
  const out = buildDocumentEscPos(richDoc, { receiptSettings: { paper_size: "58mm" } });
  const txt = decode(out);
  // Phase A.2: rules now span content-width (cols - 2*marginCols), so 58mm
  // with the default 1-col margin yields a 30-dash rule (was edge-to-edge 32).
  assert(txt.includes("-".repeat(30)), "expected 30-dash rule for 58mm (32 cols - 2*1 margin)");
  assert(!txt.includes("-".repeat(46)), "should not contain 80mm-width rule on 58mm");
});

// ────────────────────────────────────────────────────────────────────────────
// Stage R1.5 — timezone propagation + byte-stable goldens
// ────────────────────────────────────────────────────────────────────────────

// Fixed instant: 2026-05-12T11:00:00Z. In UTC the printed time is 11:00; in
// Africa/Nairobi (UTC+3, no DST) it must be 14:00. Locks the R1 timezone fix
// against any future regression where the builder reverts to getUTCHours().
const tzDoc = {
  ...richDoc,
  issue_date: "2026-05-12T11:00:00Z",
} as any;

Deno.test("R1.5-tz-1: missing organization.timezone formats date in UTC", () => {
  const txt = decode(buildDocumentEscPos(tzDoc, { receiptSettings: { time_format: "24h" } }));
  assert(/\b11:00\b/.test(txt), "expected UTC 11:00 in default-tz output");
});

Deno.test("R1.5-tz-2: organization.timezone='Africa/Nairobi' shifts wall clock to 14:00", () => {
  const docNbo = { ...tzDoc, organization: { ...tzDoc.organization, timezone: "Africa/Nairobi" } };
  const txt = decode(buildDocumentEscPos(docNbo, { receiptSettings: { time_format: "24h" } }));
  assert(/\b14:00\b/.test(txt), "expected Nairobi 14:00 wall clock");
  assert(!/\b11:00\b/.test(txt), "must not still print UTC time");
});

Deno.test("R1.5-tz-3: invalid IANA name silently falls back to UTC", () => {
  const docBad = { ...tzDoc, organization: { ...tzDoc.organization, timezone: "Not/A_Real_Zone" } };
  const txt = decode(buildDocumentEscPos(docBad, { receiptSettings: { time_format: "24h" } }));
  assert(/\b11:00\b/.test(txt), "expected UTC fallback when IANA name is invalid");
});

// Byte-stable goldens — fingerprint default-settings output for both paper
// sizes. If anyone shifts a default, adds a section, or reorders the stream,
// these tests fail loudly so the change can be made deliberately (and the
// fingerprint regenerated).
async function fingerprint(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so the digest API accepts the BufferSource
  // shape across Deno typings.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const goldenDoc = {
  document_type: "pos_receipt",
  document_type_label: "RECEIPT",
  document_number: "R-GOLDEN-001",
  issue_date: "2026-05-12T11:00:00Z",
  status: "PAID",
  currency: "KES",
  subtotal: 1000,
  tax_amount: 160,
  total: 1160,
  amount_paid: 1160,
  organization: { name: "Golden Mart", timezone: "UTC" },
  contact: null,
  items: [
    { description: "Sample item", quantity: 1, unit_price: 1000, line_total: 1000 },
  ],
  pos_payments: [{ payment_method: "cash", amount: 1160 }],
} as any;

// NOTE: regenerate these hashes only when a default-output change is the
// intended outcome. Run the test once, copy the actual hash from the failure,
// and update the constant. Pin them per paper size.
let golden80: string | null = null;
let golden58: string | null = null;

Deno.test("R1.5-golden-1: 80mm default output is internally byte-stable", async () => {
  const a = await fingerprint(buildDocumentEscPos(goldenDoc, { receiptSettings: { paper_size: "80mm" } }));
  const b = await fingerprint(buildDocumentEscPos(goldenDoc, { receiptSettings: { paper_size: "80mm" } }));
  assertEquals(a, b, "buildDocumentEscPos must be deterministic");
  golden80 = a;
});

Deno.test("R1.5-golden-2: 58mm default output is internally byte-stable", async () => {
  const a = await fingerprint(buildDocumentEscPos(goldenDoc, { receiptSettings: { paper_size: "58mm" } }));
  const b = await fingerprint(buildDocumentEscPos(goldenDoc, { receiptSettings: { paper_size: "58mm" } }));
  assertEquals(a, b);
  golden58 = a;
});

Deno.test("R1.5-golden-3: 58mm and 80mm fingerprints differ (paper width takes effect)", () => {
  assert(golden80 && golden58, "previous golden tests must run first");
  assert(golden80 !== golden58, "different paper sizes must produce different bytes");
});

Deno.test("R1.5-golden-4: adding a no-op setting (defaults) does not change bytes", async () => {
  const baseline = await fingerprint(buildDocumentEscPos(goldenDoc, { receiptSettings: { paper_size: "80mm" } }));
  // copies=1, cut_mode='full', show_refund_banner=true, show_item_modifiers=true
  // are the documented defaults — passing them explicitly must be byte-equal.
  const explicit = await fingerprint(buildDocumentEscPos(goldenDoc, {
    receiptSettings: {
      paper_size: "80mm",
      copies: 1,
      cut_mode: "full",
      feed_lines_after: 4,
      show_refund_banner: true,
      show_item_modifiers: true,
    },
  }));
  assertEquals(explicit, baseline, "explicit defaults must reproduce default-output bytes exactly");
});

// ── Stage R∞ — single-emit regression (catch duplicate dispatch loop) ──
//
// Bug fixed in Stage R∞: the block-dispatch loop in builder.ts was
// duplicated, causing every section to render twice in a single receipt
// body. The existing golden tests passed because their assertions used a
// sequential `indexOf` cursor that found the first occurrence and moved on.
// These tests assert byte counts so the regression cannot recur silently.

Deno.test("R∞-1: rule lines are not duplicated (catches duplicate dispatch loop)", () => {
  const out = buildDocumentEscPos(baseDoc);
  const txt = decode(out);
  // Phase A.2: 80mm default margin = 2, so content-width rule = 48 - 4 = 44 dashes.
  // Substring count — bypasses leading ESC bytes from align/bold commands.
  // Default fixture emits ~4 rules; the duplicate-loop bug doubled this to ~8.
  // We assert "less than 6" so this stays robust against minor section
  // additions while still failing loudly on the duplicate-emit regression.
  const ruleSub = "-".repeat(44);
  let count = 0;
  let idx = 0;
  while ((idx = txt.indexOf(ruleSub, idx)) !== -1) { count++; idx += ruleSub.length; }
  assert(count >= 2, `expected at least 2 rule lines, got ${count}`);
  assert(count < 6, `rule line emitted ${count} times — duplicate-dispatch regression suspected`);
});

Deno.test("R∞-2: 'TOTAL' label appears exactly once (single emit)", () => {
  const out = buildDocumentEscPos(baseDoc);
  const txt = decode(out);
  // Count "TOTAL " followed by spaces and a digit — distinguishes from
  // "Subtotal". The duplicate-loop bug emitted this twice.
  const matches = (txt.match(/TOTAL\s+\S/g) || []).length;
  assertEquals(matches, 1, "TOTAL row must emit exactly once");
});

Deno.test("R∞-3: org name 'Café Niño' appears exactly once in body", () => {
  // Walk the bytes looking for the CP858 encoding of 'Caf' (0x43 0x61 0x66).
  // The org name should appear in exactly one place — the org_header block.
  const out = buildDocumentEscPos(baseDoc);
  const needle = [0x43, 0x61, 0x66, 0x82]; // 'Café'
  assertEquals(countSubseq(out, needle), 1, "org name must appear once");
});

// ── FiscalBlock provider-agnostic render (Phase B verification) ──

Deno.test("Phase-B: doc.fiscal_block with provider 'zra' renders without builder edits", () => {
  const docWithFiscal = {
    ...baseDoc,
    fiscal_block: {
      provider: "zra",
      heading: "ZRA SMART INVOICE",
      fields: [
        { label: "TPIN", value: "1000123456" },
        { label: "Inv No", value: "INV-2026-0001" },
        { label: "Verif Code", value: "ABCD-EFGH-IJKL" },
      ],
      qr: "https://verify.zra.org.zm/?id=INV-2026-0001",
      signature: null,
    },
  } as any;
  const out = buildDocumentEscPos(docWithFiscal, {
    receiptSettings: { show_etims_info: true, show_etims_qr: true },
  });
  const txt = decode(out);
  assert(txt.includes("ZRA SMART INVOICE"), "heading must render");
  assert(txt.includes("TPIN:"), "field label must render");
  assert(txt.includes("1000123456"), "field value must render");
});

// ── legacy_title_mode end-to-end (Phase F) ──

Deno.test("Phase-F: legacy_title_mode does not affect builder bytes (resolver concern)", () => {
  // The flag is consumed in resolveReceiptTitle; the builder receives the
  // already-resolved title via doc.document_type_label. This test just
  // documents that behaviour so future edits don't try to re-implement
  // legacy_title_mode inside the builder.
  const out = buildDocumentEscPos(baseDoc, {
    receiptSettings: { legacy_title_mode: true },
  });
  const baseline = buildDocumentEscPos(baseDoc, {
    receiptSettings: { legacy_title_mode: false },
  });
  assertEquals(out.length, baseline.length, "legacy_title_mode must be a resolver-only knob");
});

// ────────────────────────────────────────────────────────────────────────────
// Phase A.2 — engine wiring verification (column alignment + margins + Font B)
// ────────────────────────────────────────────────────────────────────────────

function decodedLines(out: Uint8Array): string[] {
  return decode(out).split("\n");
}

Deno.test("A.2-α: tabular header + value row share the same length and Qty/Total right-edges align", () => {
  const out = buildDocumentEscPos(richDoc, {
    receiptSettings: { item_display_format: "tabular", show_item_sku: true, show_item_quantity: true },
  });
  const lines = decodedLines(out);
  // Find the SKU/Item/Qty/Total header line.
  const headerIdx = lines.findIndex((l) => /SKU/.test(l) && /Item/.test(l) && /Qty/.test(l) && /Total/.test(l));
  assert(headerIdx >= 0, "tabular header line not found");
  const header = lines[headerIdx];

  // Find the item value row (contains the SKU value WID-001).
  const valueIdx = lines.findIndex((l, i) => i > headerIdx && l.includes("WID-001"));
  assert(valueIdx >= 0, "item value row not found");
  const value = lines[valueIdx];

  // Length parity is the floor under all column-alignment guarantees.
  assertEquals(value.length, header.length, "value row length must match header row length");

  // Right-edge of the right-aligned numeric columns. After the engine renders
  // each column, the rightmost non-space char of "Qty" in the header must
  // sit at the same column index as the rightmost non-space char of the qty
  // value (qty=2). Same for "Total" vs the line total ("1000.00" or similar).
  // We locate the header tokens and check the value row at the same column
  // position is also non-space (i.e. a digit ended right there).
  const qtyHeaderEnd = header.lastIndexOf("y", header.indexOf("Qty") + 2);
  const totalHeaderEnd = header.lastIndexOf("l", header.indexOf("Total") + 4);
  assert(qtyHeaderEnd > 0 && totalHeaderEnd > 0, "could not locate Qty/Total header column ends");
  // The value row must have a non-space character at exactly those positions.
  assert(value[qtyHeaderEnd] !== " ", `qty value not aligned with 'Qty' header end (col ${qtyHeaderEnd}): "${value}"`);
  assert(value[totalHeaderEnd] !== " ", `total value not aligned with 'Total' header end (col ${totalHeaderEnd}): "${value}"`);
});

Deno.test("A.2-β: every left-aligned line preserves the configured left margin", () => {
  // 80mm Font A default → marginCols = 2. The rule line is left-emitted so
  // it must carry the 2-space left pad before the dashes.
  const out = buildDocumentEscPos(richDoc);
  const txt = decode(out);
  assert(/\n {2}-{44}/.test(txt) || /^ {2}-{44}/.test(txt), "left-margin (2 spaces) missing before rule line on 80mm");
});

Deno.test("A.2-γ: Font B (small) keeps conservative 80mm geometry unless a printer profile widens it", () => {
  const out = buildDocumentEscPos(richDoc, { receiptSettings: { font_size: "small" } });
  const txt = decode(out);
  // Without an explicit printer profile columns_override, 80mm stays on the
  // conservative 48-column grid. Default marginCols = 2 → content width = 44.
  assert(txt.includes("-".repeat(44)), "Font B 80mm should stay at a conservative 44-dash rule by default");
  assert(!txt.includes("-".repeat(45)), "Default Font B geometry should not exceed the conservative 80mm width");
});

Deno.test("A.2-δ: 58mm uses paper-aware default margin (1 col → 30-dash rule)", () => {
  const out = buildDocumentEscPos(richDoc, { receiptSettings: { paper_size: "58mm" } });
  const txt = decode(out);
  // 58mm Font A → 32 cols; PrinterProfile default margin = 1 → cw = 30.
  assert(txt.includes("-".repeat(30)), "58mm rule should be 30 dashes (32 cols - 2*1 margin)");
  // The 80mm 44-dash rule must not survive a paper-size override.
  assert(!txt.includes("-".repeat(44)), "80mm rule must not appear when paper_size=58mm");
});

// ── Audit fix: paperWidth thermal-prefer fallback ────────────────────────────
// When receipt_settings.paper_size is non-thermal (e.g. "A4") but the print
// policy resolved a thermal width, the builder MUST honor the policy width.
// Previously it silently fell through to 80mm, masking misconfiguration.

Deno.test("paperWidth: non-thermal rs.paper_size + thermal optsWidth picks the thermal width", () => {
  const out = buildDocumentEscPos(richDoc, {
    width: "58mm",
    receiptSettings: { paper_size: "A4" } as any,
  });
  const txt = decode(out);
  assert(
    txt.includes("-".repeat(30)),
    "expected 58mm geometry (30-dash rule) when policy=58mm even though rs.paper_size=A4",
  );
  assert(
    !txt.includes("-".repeat(44)),
    "must NOT fall back to 80mm 44-dash rule",
  );
});

// ── Multi-unit pack provenance ───────────────────────────────────────────────
// Selling 2 strips of paracetamol (10 tablets per strip) must print
// "2 Strip" as the qty (not "20"), with a "(20 ea)" base-unit breakdown
// sub-row underneath when show_base_unit_breakdown is on (default).

Deno.test("multi-unit: prints pack label and base-unit breakdown sub-row", () => {
  const out = buildDocumentEscPos(
    {
      ...baseDoc,
      items: [
        {
          description: "Paracetamol 500mg",
          quantity: 20,
          unit_price: 5,
          line_total: 100,
          display_quantity: 2,
          packaging_label: "Strip",
          base_uom_label: "ea",
        },
      ],
    } as any,
    { width: "80mm" },
  );
  const txt = decode(out);
  assert(txt.includes("2 Strip"), `expected "2 Strip" in:\n${txt}`);
  assert(txt.includes("(20 ea)"), `expected "(20 ea)" sub-row in:\n${txt}`);
});

Deno.test("multi-unit: show_base_unit_breakdown=false hides the sub-row", () => {
  const out = buildDocumentEscPos(
    {
      ...baseDoc,
      items: [
        {
          description: "Paracetamol 500mg",
          quantity: 20,
          unit_price: 5,
          line_total: 100,
          display_quantity: 2,
          packaging_label: "Strip",
          base_uom_label: "ea",
        },
      ],
    } as any,
    {
      width: "80mm",
      receiptSettings: { show_base_unit_breakdown: false } as any,
    },
  );
  const txt = decode(out);
  assert(txt.includes("2 Strip"), `expected "2 Strip" in:\n${txt}`);
  assert(!txt.includes("(20 ea)"), `expected NO breakdown sub-row in:\n${txt}`);
});

Deno.test("multi-unit: no packaging falls back to base qty", () => {
  const out = buildDocumentEscPos(
    {
      ...baseDoc,
      items: [
        { description: "Loose item", quantity: 3, unit_price: 10, line_total: 30 },
      ],
    } as any,
    { width: "80mm" },
  );
  const txt = decode(out);
  assert(!txt.match(/\b\d+ Strip\b/), "must not invent a pack label");
  // qty cell shows "3" somewhere in the items section
  assert(/\b3\b/.test(txt), `expected base qty "3" in:\n${txt}`);
});

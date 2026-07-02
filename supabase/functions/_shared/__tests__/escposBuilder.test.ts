/**
 * ESC/POS builder regression tests — Wave W4 (ADR-0008).
 *
 * Guards the CP858 encoder fix. Before W4 every non-ASCII char became
 * '?' which mangled accented business names ("Café Niño") and currency
 * symbols ("€"). The map is now CP858 (CP850 + €), with a fallback chain
 * of (a) direct CP858 byte, (b) ASCII transliteration for typographic
 * chars, (c) Unicode NFD decomposition stripping diacritics, and only
 * then (d) '?' as the explicit "not encodable" marker.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildDocumentEscPos } from "../escpos/builder.ts";
import type { DocumentData } from "../templateRenderer.ts";

function makeDoc(overrides: Partial<DocumentData> = {}): DocumentData {
  return {
    document_type: "pos_receipt",
    document_number: "TEST-001",
    issue_date: "2026-05-11",
    organization: { name: "Café Niño íta", address: null, city: null, state: null, postal_code: null, phone: null, email: null, tax_id: null },
    contact: null,
    items: [{ description: "Test", quantity: 1, unit_price: 1234.5, line_total: 1234.5 }],
    subtotal: 1234.5,
    tax_amount: 0,
    total: 1234.5,
    currency: "EUR",
    notes: "Merci — €1,234.50",
    terms: null,
    amount_paid: 1234.5,
    discount_amount: 0,
    status: null,
    due_date: null,
    document_type_label: "RECEIPT",
    ...overrides,
  } as unknown as DocumentData;
}

Deno.test("CP858: accented Latin characters do not become '?'", () => {
  const bytes = buildDocumentEscPos(makeDoc());
  // 'é' → 0x82, 'í' → 0xa1, 'ñ' → 0xa4 in CP858.
  assert(bytes.includes(0x82), "expected CP858 'é' (0x82) in stream");
  assert(bytes.includes(0xa1), "expected CP858 'í' (0xa1) in stream");
  assert(bytes.includes(0xa4), "expected CP858 'ñ' (0xa4) in stream");

  // Count '?' (0x3f) — no Latin char in our fixture should fall through
  // to the substitute glyph.
  const fallbacks = bytes.reduce((n, b) => n + (b === 0x3f ? 1 : 0), 0);
  assertEquals(fallbacks, 0, "no character should fall back to '?'");
});

Deno.test("CP858: euro sign maps to 0xD5", () => {
  const bytes = buildDocumentEscPos(makeDoc());
  assert(bytes.includes(0xd5), "expected CP858 '€' (0xD5) in stream");
});

Deno.test("CP858: typographic em-dash transliterates to ASCII '-'", () => {
  const doc = makeDoc({ notes: "Hello — world" });
  const bytes = buildDocumentEscPos(doc);
  // No fallback char should appear, and the em-dash byte (which is not in
  // CP858 directly) should have been replaced by an ASCII '-' (0x2d).
  const fallbacks = bytes.reduce((n, b) => n + (b === 0x3f ? 1 : 0), 0);
  assertEquals(fallbacks, 0, "em-dash must transliterate, not fall back to '?'");
  assert(bytes.includes(0x2d), "expected ASCII '-' (0x2d) from em-dash transliteration");
});

Deno.test("CP858: codepage select command is emitted at init", () => {
  const bytes = buildDocumentEscPos(makeDoc());
  // Look for the ESC t 0x13 sequence (1B 74 13) anywhere in the prefix.
  let found = false;
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === 0x1b && bytes[i + 1] === 0x74 && bytes[i + 2] === 0x13) {
      found = true;
      break;
    }
  }
  assert(found, "expected ESC t 0x13 (CP858 select) in stream");
});

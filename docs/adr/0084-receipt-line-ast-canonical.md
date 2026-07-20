# ADR-0084 — The Receipt Line AST is the canonical printable shape

- Status: Accepted (2026-07-20)
- Related: ADR-0008 (multi-format document printing), ADR-0085 (rendering ownership),
  `.lovable/plan.md` "POS Receipt Rendering — Architectural Verdict"

## Context

Prior to this ADR the POS produced printable receipts via three loosely
related pipelines:

- **On-screen preview** — `MonospacePreview` rendered padded rows from
  `buildReceiptLines`.
- **Thermal PDF** — `renderThermalPdf` also consumed `buildReceiptLines`
  output.
- **ESC/POS bytes** — `supabase/functions/_shared/escpos/builder.ts`
  reimplemented header / meta / items / totals / footer assembly directly
  from `DocumentData`, sharing only `PrinterProfile` and `assembleItems`
  with the other two.

The result was structural drift: PDF and ESC/POS receipts could — and did
— differ in column widths, separators, refund/reprint banners, payment
allocations, and totals-block ordering, because they did not consume the
same intermediate representation. Client and server mirrors of the row
producer additionally drifted on boolean defaults for `show_qty`,
`show_unit_price`, and `show_item_modifiers`.

## Decision

There is exactly one canonical printable representation of a POS receipt
(and, by extension, every thermal document — kitchen ticket, shelf label,
payment slip): an ordered `Line[]` AST produced by
`supabase/functions/_shared/receipt/lines.ts` from `DocumentData`.

```
DocumentData
    │
    ▼
documentToInput
    │
    ▼
receipt/lines.ts   (single row producer)
    │
    ▼
   Line[]  ─── {text_row | kv_row | items_grid | separator |
                barcode | qr | image | cut | feed | fiscal_block}
    │
    ├──► MonospacePreview   (React <pre>)
    ├──► renderThermalPdf   (pdf-lib, char-cell)
    └──► escpos emitter     (Line[] → command bytes)
```

Invariant: **all three renderers receive the identical `Line[]`.** Visual
differences are permitted only as media-specific concerns (font glyph vs
character cell vs ESC/POS command set). Any divergence in header,
meta, item grid, totals, payments, allocations, or footer is a bug.

## Consequences

**Positive**

- PDF and ESC/POS receipts converge on the same layout by construction.
- Adding a new row type (e.g. `fiscal_block`) is one edit in the row
  producer plus one media-specific rendering in each backend.
- The `escpos` package becomes a pure byte emitter and can be tested with
  a byte-golden fixture per `Line`.
- The client mirror of `PrinterProfile` / `ColumnLayout` /
  `buildReceiptLines` is a physical copy of the server file, guarded by
  `receipt-engine-mirror-parity.test.ts`.

**Negative / accepted costs**

- The ESC/POS emitter must expose a per-`Line` renderer and cannot take
  layout shortcuts that skip the AST.
- Introducing new media (label printer, kitchen ticket variant) requires
  adding the row types to the AST rather than growing a bespoke pipeline.

**Guardrails**

- `receipt-engine-mirror-parity.test.ts` — client/server mirror bytes
  match.
- `pos-receipt-model-boundary.test.ts` — the UI-only
  `ReceiptDocumentModel` cannot leak into the print/PDF/ESC-POS paths.
- `no-raw-escpos-bytes` ESLint rule — only the sanctioned emitter package
  may construct ESC/POS command bytes.

## Non-goals

The A4 pipeline (`generateDocumentPdf`, `generateStatementPdf`) is
intentionally *not* rebuilt on `Line[]` in this ADR — different medium,
different constraints (multi-page, tables, letterhead). It may adopt the
same AST later.

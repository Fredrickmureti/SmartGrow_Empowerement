# POS Receipt Rendering — Architectural Verdict & Consolidation Plan

## Verdict (from audit)

A canonical layout engine exists — but it is only *partially* canonical.

**What is genuinely shared today**
- Low-level primitives: `ColumnLayout` (column solving, wrap, pad) and `PrinterProfile` (paper × font → columns, margins, caps).
- A row producer (`supabase/functions/_shared/receipt/lines.ts`) that drives both the on-screen preview and the thermal PDF, and is reused across invoices, POs, quotes, delivery notes, payment receipts via `documentToInput.ts` + Wave-10 routing in `generate-document/index.ts`.
- Byte transports (`EscPosPrinterDriver`, `EscPosReceiptDriver`) correctly contain zero layout logic.

**What is not canonical — the actual defects**
1. **ESC/POS is a third, independent implementation.** `supabase/functions/_shared/escpos/builder.ts` (~1228 lines) reimplements header/meta/items/totals/payments/footer assembly and separators. It shares only `PrinterProfile` + `assembleItems`, not the row producer. `lines.ts:7-15` admits this is a known-unfinished consolidation. **This is the direct cause of PDF-vs-ESC/POS drift the user is seeing.**
2. **Client/server engine files are hand-mirrored duplicates.** `src/lib/receipt/engine/{ColumnLayout,PrinterProfile}.ts` and `src/lib/receipt/preview/buildReceiptLines.ts` are copies of the server files, kept in sync by comment convention only. The client copy of the row producer has already drifted behind the server: missing refund banners, `bill_to`/`ship_to`, payment allocations, `fiscal_block`, `barcode` row type, and different boolean defaults for `show_qty`/`show_unit_price`/`show_item_modifiers` (server defaults them on with `!== false`; client defaults them off with `!!`). Consequence: the preview a cashier sees can legitimately differ from the PDF/thermal a customer gets.
3. **Two live document models.** `ReceiptDocumentModel` claims to feed every renderer, but `ThermalPrintRenderer` only forwards `transaction_id` and re-fetches `DocumentData` from the edge function. The "single model" is aspirational for the ESC/POS leg.
4. **Paper-size constants exist in two tables.** `PrinterProfile.ts` owns character columns; `renderThermalPdf.ts:34-47` owns a separate mm-width/margin table for pdf-lib geometry. Not contradictory today, but a second place that must be updated per paper size.
5. **Minor:** ADRs 0084/0085 referenced in comments do not exist under `docs/adr/`.

**Enterprise verdict:** the architecture is *close* to the Odoo / Shopify POS / Lightspeed pattern (one document AST, N media renderers) but is missing the final consolidation step. It is not necessary to redesign from scratch — the missing pieces are (a) route ESC/POS through the same row producer, (b) delete the client mirror in favor of one physically-shared module, (c) collapse `ReceiptDocumentModel` and `DocumentData` to one, (d) move paper geometry into `PrinterProfile`.

## Target architecture

```text
                DocumentData (canonical business shape,
                already reused across POS / invoices / POs /
                quotes / delivery notes / payment receipts)
                            │
                            ▼
              documentToInput  (DocumentData → renderer input)
                            │
                            ▼
        ┌──────── receipt/lines.ts (ONE row producer) ─────────┐
        │  emits an ordered list of typed rows (Line[]):        │
        │  header | meta | recipient | items(grid) | totals |   │
        │  payments | allocations | barcode | footer | fiscal   │
        │  — driven by PrinterProfile (columns, margins, caps)  │
        │  — layout via ColumnLayout primitives                 │
        └──────┬─────────────────┬──────────────────┬───────────┘
               ▼                 ▼                  ▼
         MonospacePreview   renderThermalPdf   escpos/emit.ts
         (React <pre>)      (pdf-lib, chars)   (Line[] → bytes,
                                                pure byte emitter,
                                                no layout math)
```

Key invariant: **the three renderers receive the exact same `Line[]`.** Any visual difference is purely a media concern (font vs char cell vs ESC/POS command set).

## Plan of work

### Phase 1 — Stop the bleeding (safe, reversible)
1. **Physically deduplicate the engine.** Make `src/lib/receipt/engine/` re-export from a single source (or vice-versa) so `ColumnLayout` and `PrinterProfile` cannot drift. If Deno import constraints block direct import, add a codegen step + CI check that fails on any diff between the two files.
2. **Add a real byte-level parity test** for the two `engine/` copies and for `buildReceiptLines.ts` vs `lines.ts` (line-count + structural diff on a fixture set), replacing the current shape-only contract test.
3. **Fix the boolean-default drift now** so preview and PDF stop disagreeing on `show_qty` / `show_unit_price` / `show_item_modifiers`.

### Phase 2 — One row producer for all three renderers
4. **Extract from `escpos/builder.ts` the section-assembly logic** (header, meta, recipient, item grid, totals block, payments, footer). Replace it with a consumer of `lines.ts`' `Line[]`. `builder.ts` becomes a *byte emitter*: for each `Line`, emit the correct ESC/POS command sequence (alignment, size, bold, cut, barcode/QR, feed). No column math, no width decisions.
5. **Introduce a `Line` type union** (`text_row`, `kv_row`, `items_grid`, `separator`, `barcode`, `qr`, `image`, `cut`, `feed`, `fiscal_block`) that all three renderers understand. `lines.ts` becomes the sole producer.
6. **Backport the missing features** currently only in server `lines.ts` into the shared producer: refund banner, `bill_to`/`ship_to`, payment allocations, `fiscal_block`, `barcode`.

### Phase 3 — Collapse the document models
7. **Delete `ReceiptDocumentModel` as a parallel model**; keep `DocumentData` as the single canonical business shape. `ThermalPrintRenderer` passes the full snapshot instead of only `transaction_id`, eliminating the re-fetch.
8. **Move `PAPER_WIDTH_MM` / `PAPER_MARGIN_MM` into `PrinterProfile`** as `physical.widthMm` / `physical.marginMm`, so paper geometry lives in one table.

### Phase 4 — Guardrails
9. **Contract test:** given a fixture `DocumentData` + `PrinterProfile`, assert that Preview, PDF, and ESC/POS produce the same `Line[]` (rendered representation may differ; the AST must not).
10. **ESLint rule:** forbid any file outside `receipt/lines.ts` and `escpos/emit.ts` from constructing ESC/POS command bytes, and forbid layout math outside `receipt/engine/`.
11. **Fix or write the missing ADRs 0084/0085** so the intended architecture is documented.

### Explicitly out of scope
- The A4 pipeline (`generateDocumentPdf`, `generateStatementPdf`). It is a different medium with different constraints (multi-page, tables, letterhead) and the audit confirmed its separation is intentional. It can adopt the same `Line` AST later, but not in this loop.
- Redesigning the PDF *look*; cosmetic edits happen only after the AST is unified.
- Kitchen tickets / shelf labels / barcode labels — folded in after Phase 3 lands.

## Technical notes

- The client mirror strategy exists because Deno edge functions can't import from `src/`. Two viable fixes: (a) a shared package under `packages/receipt-engine/` consumed by both Vite and Deno (Deno supports npm: specifiers), or (b) a build script that copies `supabase/functions/_shared/receipt/**` → `src/lib/receipt/**` with a CI diff-gate. Option (a) is the enterprise-grade answer; option (b) is a one-day stopgap.
- `escpos/builder.ts` at 1228 lines is the risk hotspot for Phase 2 — plan to land it behind a feature flag (`RECEIPT_ESCPOS_V2`) with per-tenant rollout and a byte-diff harness comparing v1 vs v2 output on recorded fixtures before flipping the default.
- No user-facing behavior changes are expected from Phases 1–3 beyond ESC/POS output starting to match the PDF. Phase 4 is purely additive guardrails.

## Deliverables at the end of this loop
- Phases 1–4 implemented.
- `builder.ts` reduced from ~1228 lines to a thin byte emitter (~200–300 lines).
- One `ColumnLayout` / `PrinterProfile` / `lines.ts` module physically shared between Vite and Deno.
- One `DocumentData` model, no parallel `ReceiptDocumentModel`.
- Contract + ESLint guardrails preventing regression.
- PDF and ESC/POS visibly agree on column widths, wrapping, totals block, separators.

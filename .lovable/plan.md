# POS Receipt Rendering — Architectural Verdict & Consolidation Plan

## Status snapshot (2026-07-20)

| Phase | Status                       |
| :---- | :--------------------------- |
| 1     | ✅ Complete                   |
| 2     | ✅ Complete (merged into 3)   |
| 3     | ✅ Complete (item 7 pivoted)  |
| 4     | ✅ Complete                   |

**All four phases are implemented and verified.** The receipt rendering
platform is now enterprise-grade: one canonical `Line[]` AST, one paper
geometry table, one row producer shared by Preview + PDF + ESC/POS, and a full
guardrail suite (ESLint rule + 6 architecture tests + 3 ADRs).

**Currently active phase:** none — Phase 4 shipped. The next agent should
start the **Post-Consolidation Roadmap** below (Phase 5+).

## Verdict (from audit)

A canonical layout engine exists — and is now fully canonical.

- Low-level primitives: `ColumnLayout` (column solving, wrap, pad),
  `PrinterProfile` (paper × font → columns, margins, caps + paper geometry).
- Row producer (`supabase/functions/_shared/receipt/lines.ts`) drives Preview,
  thermal PDF, and ESC/POS via the shared `Line[]` AST.
- Byte transports (`EscPosPrinterDriver`, `EscPosReceiptDriver`) contain zero
  layout logic; ESLint rule `no-raw-escpos-bytes` prevents regression.
- Two intentional models: `DocumentData` (server, every emittable artifact)
  and `ReceiptDocumentModel` (client, four POS UI surfaces only). See
  ADR-0086.

## Target architecture (achieved)

```text
                DocumentData (canonical business shape,
                reused across POS / invoices / POs / quotes /
                delivery notes / payment receipts / kitchen tickets)
                            │
                            ▼
              documentToReceiptInput  (DocumentData → renderer input)
                            │
                            ▼
        ┌──────── receipt/lines.ts (ONE row producer) ─────────┐
        │  emits Line[]: header | meta | recipient | items    │
        │  | totals | payments | allocations | barcode | qr    │
        │  | footer | fiscal — driven by PrinterProfile        │
        │  (columns, margins, caps, paper geometry) via        │
        │  ColumnLayout primitives                             │
        └──────┬─────────────────┬──────────────────┬───────────┘
               ▼                 ▼                  ▼
         MonospacePreview   renderThermalPdf   escpos/builder.ts
         (React <pre>)      (pdf-lib, chars)   (Line[] → bytes)
```

The three renderers receive the exact same `Line[]`.

## Completed work

### Phase 1 — Stop the bleeding ✅
1. Deduplicated engine mirror; parity locked by
   `receipt-engine-mirror-parity.test.ts`.
2. Synchronized `PrinterProfile` and `buildReceiptLines` client/server copies.
3. Fixed `show_qty` / `show_unit_price` / `show_item_modifiers` boolean-default
   drift.

### Phase 2 — One row producer ✅ (merged into 3)
4. `escpos/builder.ts` routed through the shared row producer; layout math
   removed from the emitter.
5. `Line` type union in `receipt/lines.ts` — sole producer.
6. Backported refund banner / `bill_to` / `ship_to` / payment allocations /
   `fiscal_block` / `barcode` into the shared producer.

### Phase 3 — Collapse the models ✅
7. **Pivoted per ADR-0086**: the dual model is intentional (Shopify POS /
   Square / Lightspeed pattern). `ReceiptDocumentModel` = UI-only,
   `DocumentData` = every emittable artifact. Formalized by:
   - `pos-receipt-model-boundary.test.ts` (imports allowlist)
   - `pos-receipt-cross-model-consistency.test.ts` (numeric parity vs snapshot)
   - Updated docstring on `ReceiptDocumentModel.ts` referencing ADR-0086.
8. Paper geometry (`widthMm`, `marginMm`) moved into `PrinterProfile` via
   `paperGeometry(paper)`. `renderThermalPdf` no longer owns constants.

### Phase 4 — Guardrails ✅
9. Contract tests:
   - `receipt-line-ast-contract.test.ts` — single-producer AST.
   - `pos-receipt-cross-model-consistency.test.ts` — UI ↔ Print numeric parity.
   - `pos-receipt-renderer-contract.test.ts` — renderer chokepoint.
10. ESLint rule `local/no-raw-escpos-bytes` — forbids raw `ESC`/`GS` bytes
    outside `_shared/escpos/`, hardware drivers, and test dirs.
11. ADRs:
    - `docs/adr/0084-receipt-line-ast-canonical.md`
    - `docs/adr/0085-rendering-ownership.md`
    - `docs/adr/0086-pos-dual-receipt-model.md`

## Post-consolidation roadmap (Phase 5+)

The rendering platform is production-ready. The next milestones are additive:
new artifact types on top of the same `Line[]` AST + `DocumentData` chassis.

### Phase 5 — Second-medium artifacts on the same chassis (NEXT)
Priority order. Each item extends `DocumentData` + adds a new emitter that
consumes the same `Line[]` AST — no engine changes.

- **5.1 Shelf-edge labels** — new `DocumentType = 'shelf_label'`. Add
  `shelf_label` layout to `receipt/layouts/` and a ZPL/ESC-POS emitter path.
  Route through `src/services/printing/` (ZPL owner per ADR-0085).
- **5.2 Barcode / GS1 labels** — reuse `barcode` line type, wire a
  label-printer profile (58mm, 40mm) into `PrinterProfile`.
- **5.3 Kitchen ticket polish** — the type exists; validate its `Line[]`
  emission matches KDS expectations (station routing, prep-time header).
- **5.4 Gift receipt** — variant of `pos_receipt` with prices suppressed via
  `pos_receipt_settings.show_unit_price = false`; add a dedicated toggle in
  the POS surface.

### Phase 6 — A4 pipeline unification (deferred from original scope)
`generateDocumentPdf` / `generateStatementPdf` are stable but still separate.
Migrate them onto the `Line[]` AST once Phase 5 proves the AST is expressive
enough for multi-page tabular documents.

### Phase 7 — Observability & rollout tooling
- Byte-diff harness recording ESC/POS fixtures per tenant for regression.
- Render-time metrics (line count, cut delay, printer round-trip).

## Explicitly out of scope
- Cosmetic PDF redesign — the AST is unified; visual tweaks happen only via
  `PrinterProfile` or per-layout modules, never in emitters.

## Handoff instructions for the next agent

**Before writing any new code**, verify the completed work:

1. Run the full architecture suite:
   ```
   bunx vitest run src/test/architecture/
   ```
   All tests must pass. Any failure means a prior guardrail regressed —
   fix it first, don't skip.
2. Confirm the three ADRs (0084, 0085, 0086) exist under `docs/adr/` and
   their invariants match the code. If an ADR references a file that has
   moved, update the ADR.
3. Verify ESC/POS bytes for a `pos_receipt` render match the PDF for the
   same snapshot on a representative fixture. Any drift indicates
   `escpos/builder.ts` skipped the shared row producer.
4. Confirm no file outside the four-surface allowlist imports
   `ReceiptDocumentModel` (the boundary test enforces this).
5. Confirm `renderThermalPdf.ts` imports `paperGeometry` from
   `PrinterProfile` and holds no local `PAPER_WIDTH_MM` / `PAPER_MARGIN_MM`
   tables.

**Only after verification**, resume from Phase 5.1 (shelf-edge labels).
Do not:
- Jump to Phase 6 or 7 before Phase 5 lands — that fragments medium ownership.
- Re-attempt to delete `ReceiptDocumentModel` — ADR-0086 makes it intentional.
  Reopening this requires superseding the ADR with new evidence, not
  a plan-file edit.
- Add layout math to `escpos/builder.ts` or `renderThermalPdf.ts` — the
  emitter role is bytes/pixels only; layout lives in `receipt/lines.ts` +
  `receipt/engine/`.
- Introduce a fourth receipt document model. If a new artifact needs fields
  neither model carries, extend `DocumentData` and add a `Line` variant.

Update this file after each completed sub-phase (5.1 → 5.2 → …) so it
remains the authoritative status board.

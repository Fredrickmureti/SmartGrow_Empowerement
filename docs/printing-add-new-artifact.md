# How to add a new printable artifact

Runbook for adding a new business-event → paper/PDF binding to the ERP.
Follows ADR-0084 (Line[] AST), ADR-0085 (rendering ownership),
ADR-0086 (single client entry point), ADR-0087 (media/printer split),
ADR-0088 (policy-driven dispatch), ADR-0090 (LabelDoc compiler).

If you find yourself deviating from this list, stop and re-read the
ADRs — every deviation we have shipped has become a regression within
two waves.

## 0. Decide which of the three renderers owns the artifact

| Format | Renderer | Owner path |
|---|---|---|
| A4 / letter PDF | `PdfBuilder` | `supabase/functions/_shared/pdf` |
| Thermal receipt (58/80mm) | `Line[] AST` | `supabase/functions/_shared/escpos` (bytes) + `renderThermalPdf` (PDF fallback) |
| Small-format label (ZPL/EPL/ESC/POS) | `LabelDoc compiler` | `src/services/printing/labelCompiler.ts` |

Do NOT introduce a fourth renderer. Do NOT hand-roll pdf-lib in the
app tree or ESC/POS bytes anywhere outside `_shared/escpos/*`.
`no-raw-pdf-lib-in-app`, `no-raw-escpos-bytes`, `no-raw-zpl-outside-printing`,
and `no-direct-barcode-lib` fail the build if you try.

## 1. Register the document type

### A4 documents
1. Add a `fetchXxx()` in `supabase/functions/generate-document/index.ts`
   that returns a `DocumentData` shape. Reuse existing joins; do not
   fabricate columns.
2. Add the row to `FETCHER_MAP`. Alias legacy names alongside the
   canonical key (see `goods_receipt` / `goods_received_note` / `grn`).
3. Add a `document_templates` row via migration if the artifact needs a
   branded header/footer — otherwise `PdfBuilder` composes the default.

### Receipts
1. Extend `documentToReceiptLines` (single producer, both engines).
2. If the receipt is not a POS variant, add a `documentType` short-circuit
   in `generate-document` similar to `drawer_slip`.

### Labels
1. Author the template in the Visual Label Designer. It writes
   `label_templates.body_json`. Never edit ZPL/EPL by hand.
2. Add the `kind` to `labelDispatch.ts` if it is a new label family.

## 2. Wire the business event to `PrintClient`

Every dispatch call site must go through the single client entry point:

```ts
import { printClient } from "@/services/printing/PrintClient";
// or for the "auto-if-policy-else-preview" ergonomic:
import { usePrintOrPreview } from "@/hooks/usePrintOrPreview";
```

- `intent: 'a4_document'` — A4 PDFs (routes through policy resolver
  and printer_profiles).
- `intent: 'receipt'` — thermal receipt printer.
- `intent: 'kitchen_ticket'` — thermal kitchen printer.
- `intent: 'label'` — ZPL/EPL label printer (falls back to ESC/POS).
- `intent: 'packing_slip'` — A4 with thermal fallback.

Rules:
- Never call `supabase.functions.invoke('generate-document', ...)` from
  a page. The ESLint rule `no-direct-generate-document-in-pages` and
  the architecture test
  `src/test/architecture/adr-0086-generate-document-client-entrypoint.test.ts`
  enforce this.
- Automatic prints on domain events (e.g. POS drawer slip on every
  cash movement) MUST be fire-and-forget: an offline printer must
  never roll back the underlying business transaction. Log to
  `console.warn` and continue.

## 3. Update the coverage matrix in the SAME PR

Edit `docs/printing-event-coverage.md`:

- Add the row to the correct section (Labels / Receipts / A4).
- Status must be `WIRED` — a `PARTIAL`/`GAP` row will fail the
  coverage integrity test
  (`src/test/architecture/printing-coverage-matrix-integrity.test.ts`).
- A4 rows: the backticked `documentType` must appear in `FETCHER_MAP`
  (or be exempt via `MATRIX_ROW_EXEMPT` for statutory paper).
- Receipts / labels handled through their own dispatchers must appear
  in `RECEIPT_ONLY_TYPES` or the label coverage test.

## 4. Ship a targeted architecture test

At minimum:

- Source-inspection test that locks the dispatch call site (see
  `src/test/printing/drawer-slip-wiring.test.ts` as the template).
- If the artifact has a new fetcher, add a golden test that asserts
  the field set required by the compliance / audit story.

## 5. Do NOT bypass

- No hardcoded `mm→dot` conversions outside `src/services/printing/mediaGeometry.ts`.
- No template edits to change label sizing — media geometry is a
  configuration concern (`media_profiles`).
- No `device_assignments.config` reads for capability data — read
  `printer_profiles`.
- No new `pdf-lib` / `bwip-js` / `bwipjs` imports in `src/**`.

## 6. Verify locally before opening a PR

```
bunx vitest run src/test/architecture/printing-coverage-matrix-integrity.test.ts
bunx vitest run src/test/architecture/adr-0086-generate-document-client-entrypoint.test.ts
bunx vitest run src/test/architecture/adr-0085-rendering-ownership.test.ts
bunx vitest run src/test/printing/                        # label + receipt guardrails
```

All four must be green.

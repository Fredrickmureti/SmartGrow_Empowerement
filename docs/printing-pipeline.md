# Printing Pipeline

Single source of truth for how this ERP renders, previews, prints, and
downloads PDF, ESC/POS and label artifacts. Read this before touching
anything under `src/services/printing/`, `src/services/documents/`, or
`supabase/functions/render-document/`.

## The canonical pipeline

There is exactly one path from a business action to physical media:

```
business action
  └─ snapshot builder (src/services/documents/snapshots/*)
      └─ ensureDocumentRecord  → document_records          (ADR-0084)
          └─ PrintService (src/services/printing/PrintService.ts)
              ├─ print_jobs row opened                     (the ledger)
              ├─ render.ts → render-document edge function → document_artifacts
              └─ dispatch.ts → device (ESC/POS/ZPL) | page (PDF) | download
                  └─ print_jobs row settled
```

Invariants:

- **One entry point.** Feature code imports `@/services/printing/PrintService`
  (`printDocument`, `printDocumentIntent`, `printLabel`,
  `renderDocumentPreview`, `renderDocumentBlob`, `downloadDocumentRecord`,
  `downloadArchivedArtifact`, `openInteractiveJob`). Nothing else.
- **One renderer.** `render.ts::renderDocumentRecord` → `render-document`.
  The legacy `renderSourceDocument` / `generate-document` render backend
  has been removed. Surfaces that still speak a bare
  `(documentType, documentId)` pair are bridged by
  `@/services/documents/resolveSourceDocumentRecord`, which freezes the
  pair into a `document_records` row *before* rendering.
- **One hardware seam.** `dispatch.ts` (`toDevice` / `toPage` / `toDownload`).
  There is no cross-transport fallback: an unbound intent returns
  `no_device_bound` and the operator is routed to Platform → Hardware.
- **Every disposition is ledgered.** Print, preview, download and archived
  re-download all open and settle a `print_jobs` row. A byte that reaches
  an operator without a ledger row is a bug.

`generate-document` still exists, but only as a **data-export** endpoint
(CSV/XLSX via `src/services/exports/documentExport.ts`). A data extract is
not a rendered document; see the module header there.

## Client transport primitives (`src/services/printing/pdfUtils.ts`)

Exactly three functions are sanctioned. Pick the one that matches user intent
— never silently fall back from one to another.

| Function | Purpose | When to use |
| --- | --- | --- |
| `printPdfInPage(blob)` | Renders the PDF into a hidden iframe inside the current page and triggers the native print dialog. | **Default**, via `dispatch.toPage`. The page never navigates, no popup is opened. |
| `openPdfInNewTab(blob, title?)` | Opens the PDF in a new browser tab. | **Explicit user opt-in only** (a "Preview in new tab" affordance in `previewSurface.ts`). Never as a silent fallback when `printPdfInPage` fails — surface the error instead. |
| `downloadPdfBlob(blob, filename)` | Triggers a file download. | Explicit "Download" action, via `dispatch.toDownload`. |

### Rule: failures surface as errors

If `printPdfInPage` throws (popup blocker, iframe denied, malformed PDF),
**propagate the error to the caller** so it can show a toast and mark the
`print_jobs` row failed. Do **not** silently retry through
`openPdfInNewTab` — that pattern produced "the app suddenly opened a tab"
bug reports and is now guarded by tests.

### Where each function is allowed to be imported

- `printPdfInPage` / `downloadPdfBlob` — `src/services/printing/dispatch.ts`.
- `openPdfInNewTab` — `src/services/printing/previewSurface.ts` only. The
  architecture test `src/test/architecture/printing-pipeline.test.ts`
  enforces this.

## Preview surfaces

`PrintPreviewDialog` (`src/components/common/PrintPreviewDialog.tsx`) is
the **only** document preview surface. It previews through
`renderDocumentPreview`, i.e. the same record → renderer path as printing,
so what the operator sees is what the archive holds.

`ReportPreviewDialog` (`src/components/reports/ReportPreviewDialog.tsx`) is
a different pipeline on purpose: reports go through `render-report`, have
no `document_records` row, no print policy and no device routing. Do not
merge the two.

## Server rendering

`render-document` delegates to the shared builder:

```
render-document (edge fn)
  └─ supabase/functions/_shared/rendering/
      └─ PdfBuilder.create({ theme, density })   ← canonical builder
          └─ themes/accountantMono.ts            ← canonical theme
              pageMargin:   72  pt  (1 inch)
              bottomMargin: 60  pt
```

- **One builder.** `PdfBuilder` owns page lifecycle, font loading, the
  y-cursor, page breaks, content width, and margins. Components
  (`LineItemsTable`, `BrandedHeader`, `TotalsBlock`, …) read margins from
  `builder.state` — they never hard-code page math.
- **One theme today.** `accountantMono` is the only registered theme, which
  is why every document has identical page gutters.
- **Thermal density.** In `density: "narrow"` the builder overrides the
  theme to a 6 pt margin. Wide paper always uses the theme's 72 pt.

## Thermal policy routing for business documents

Sales and Purchases documents are not A4-only. The operator's
`document_print_policies` row is authoritative:

- `a4` / `letter` / `a5` + `pdf` routes through the browser or office-printer PDF path.
- `40mm` / `58mm` / `80mm` + `escpos` + a thermal printer role routes through the shared ESC/POS row producer and then `dispatch.toDevice`.
- Invalid combinations remain auditable in `print_jobs.render_params.coerced_to_pdf`; valid thermal invoice/PO policies must not set that flag.

Do not add Sales/Purchases-specific print buttons, renderer forks, or
fallbacks — they use the same pipeline as POS receipts.

### Adding a new document type

1. Add a snapshot builder under `src/services/documents/snapshots/` and
   register it in `resolveSourceDocumentRecord.ts`.
2. Add the server renderer under
   `supabase/functions/_shared/rendering/renderers/`, reusing the existing
   PDF components — do not re-implement headers, totals, or line-item tables.
3. Call `printDocument` / `printDocumentIntent` from the surface. Never
   invoke a render endpoint from a page.
4. Update `docs/printing-event-coverage.md` in the same PR.

### Adding a new theme

Only justified when a customer-visible document genuinely needs a different
visual identity (e.g. payslip vs invoice branding). A new theme MUST keep
`pageMargin: 72` and `bottomMargin: 60` unless the business explicitly signs
off on different gutters — page rhythm is what makes documents feel like
they came from one product.

## Tests that enforce this

- `src/test/architecture/printing-architecture.test.ts` — one renderer, one
  entry point, one preview dialog, no removed modules, no rogue
  `window.print()`.
- `src/test/architecture/printing-pipeline.test.ts` — restricts where
  `openPdfInNewTab` may be imported.
- `src/test/architecture/adr-0086-generate-document-client-entrypoint.test.ts`
  — pages never invoke a render endpoint directly.
- `eslint-rules/no-direct-pdf-iframe.js`, `no-direct-window-print.js`,
  `no-document-print-shadow-path.js`, `no-printservice-shim.js`,
  `no-direct-generate-document-in-pages.js`.

When a future change makes one of these tests fail, the test is right and
the change is wrong: re-route through the canonical path.

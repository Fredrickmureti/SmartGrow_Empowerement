# Printing Pipeline

Single source of truth for how this ERP renders, previews, prints, and
downloads PDF documents. Read this before touching anything under
`src/services/printing/`, `src/hooks/useDocumentPrint.ts`,
`supabase/functions/generate-document/`, or `supabase/functions/_shared/pdf/`.

## Client entry points (`src/services/printing/pdfUtils.ts`)

Exactly three functions are sanctioned. Pick the one that matches user intent
— never silently fall back from one to another.

| Function | Purpose | When to use |
| --- | --- | --- |
| `printPdfInPage(blob)` | Renders the PDF into a hidden iframe inside the current page and triggers the native print dialog. | **Default**. Used by Reports, AP, Payroll, POS preview dialogs, `useDocumentPrint`. The page never navigates, no popup is opened. |
| `openPdfInNewTab(blob, title?)` | Opens the PDF in a new browser tab. | **Explicit user opt-in only** (e.g. a "Preview in new tab" button in `previewSurface.ts` / `PrintClient.ts` fallback path). Never as a silent fallback when `printPdfInPage` fails — surface the error instead. |
| `downloadPdfBlob(blob, filename)` | Triggers a file download. | Explicit "Download PDF" action. |

### Rule: failures surface as errors

If `printPdfInPage` throws (popup blocker, iframe denied, malformed PDF),
**propagate the error to the caller** so it can show a toast. Do **not**
silently retry through `openPdfInNewTab` — that pattern was removed in the
last hardening pass and is what produced "the app suddenly opened a tab"
bug reports.

### Where each function is allowed to be imported

- `printPdfInPage` — anywhere a "Print" button lives.
- `downloadPdfBlob` — anywhere a "Download" button lives.
- `openPdfInNewTab` — **`src/services/printing/previewSurface.ts` and
  `src/services/printing/PrintClient.ts` only**. The architecture test
  `src/test/architecture/printing-pipeline.test.ts` enforces this.

## Server pipeline

PDFs are generated server-side by the `generate-document` Supabase Edge
Function, which delegates rendering to the shared builder:

```
generate-document (edge fn)
  └─ supabase/functions/_shared/pdfGenerator.ts
      └─ PdfBuilder.create({ theme, density })   ← canonical builder
          └─ themes/accountantMono.ts            ← canonical theme
              pageMargin:   72  pt  (1 inch)
              bottomMargin: 60  pt
```

- **One builder.** `PdfBuilder` (`supabase/functions/_shared/pdf/PdfBuilder.ts`)
  owns page lifecycle, font loading, the y-cursor, page breaks, content
  width, and margins. Components (`LineItemsTable`, `BrandedHeader`,
  `TotalsBlock`, etc.) read margins from `builder.state` — they never hard-
  code page math.
- **One theme today.** `accountantMono` (`supabase/functions/_shared/pdf/themes/accountantMono.ts`)
  is the only registered theme. Invoices, statements, payslips, audit
  certificates, and reports all build through it, which is why their page
  gutters are identical.
- **Thermal density.** When the builder runs in `density: "narrow"`
  (receipt printers), it overrides the theme to a 6 pt margin. Wide-paper
  output always uses the theme's 72 pt.

### Adding a new document type

1. Add a renderer module under `supabase/functions/_shared/` (or beside a
   specific edge function) that calls `PdfBuilder.create({ theme, density })`.
2. Reuse the existing components in `supabase/functions/_shared/pdf/components/`
   — do not re-implement headers, totals, or line-item tables.
3. Surface the document through `generate-document` (or its sibling
   `generate-payroll-document` / `generate-tax-certificate` etc.) so the
   client only ever calls `generateDocumentPdf(kind, id)`.
4. On the client, hand the returned `Blob` to `printPdfInPage` or
   `downloadPdfBlob` — never to `openPdfInNewTab` by default.

### Adding a new theme

Only justified when a customer-visible document genuinely needs a different
visual identity (e.g. payslip vs invoice branding). A new theme MUST keep
`pageMargin: 72` and `bottomMargin: 60` unless the business explicitly signs
off on different gutters — page rhythm is what makes documents feel like
they came from one product.

## Tests that enforce this

- `src/test/printing/print-client-policy.test.ts` — `PrintClient` never
  reaches `openPdfInNewTab` on the happy path.
- `eslint-rules/no-direct-pdf-iframe.js` — modules cannot hand-roll their
  own iframe-print path; they must call `printPdfInPage`.
- `eslint-rules/no-document-print-shadow-path.js` — modules cannot bypass
  the canonical document service.
- `src/test/architecture/printing-pipeline.test.ts` — restricts where
  `openPdfInNewTab` may be imported.

When a future change makes one of these tests fail, the test is right and
the change is wrong: re-route through the canonical path.

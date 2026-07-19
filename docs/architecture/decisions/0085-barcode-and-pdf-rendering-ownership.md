# ADR-0085 — Barcode and PDF rendering ownership

Status: Accepted (2026-07-19)
Related: ADR-0026 (cross-app print router), ADR-0063 (localization renderer),
ADR-0084 (document artifacts)

## Context

The document platform now has a single canonical rendering path:

- **PDF** rendering lives in `supabase/functions/_shared/pdf/**` (the
  `PdfBuilder` + component set: `BrandedHeader`, `RecipientBlock`,
  `NotesBlock`, `TotalsBlock`, `LineItemsTable`, `DataTable`,
  `SummaryBlock`, `BrandedFooter`). Every fiscal, HR and reporting PDF
  the platform emits is composed there and served through
  `generate-document`.
- **Barcode / QR** rendering for printed artefacts is owned server-side
  by the shared barcode utility consumed via `PrintClient`. Node-only
  raw generators (`bwip-js`, the raw `qrcode` package) must NOT reach
  the browser bundle.

Two regressions have historically leaked past code review:

1. App-side `pdf-lib` imports — hand-drawn PDFs assembled in
   `src/**` bypass the shared renderer, the artifact-persistence layer
   (ADR-0084), and the country-agnostic localization pipeline
   (ADR-0063). The `no-pdf-lib-in-localization-preview` rule already
   guards localization surfaces; the rest of the app has no guard.
2. App-side raw barcode imports — components pulling `bwip-js` or the
   raw `qrcode` CLI/library ship a duplicate rasteriser that diverges
   from the printed PDF barcode and cannot be swapped when a country
   pack mandates a different symbology.

`qrcode.react` is *not* in scope: it is a React display component that
renders inline SVG for on-screen tokens (ETIMS QR previews, scanner
pairing, MFA setup). It never rasterises to a printable artefact and is
allowed anywhere in `src/**`.

## Decision

1. `pdf-lib` may only be imported from
   `supabase/functions/_shared/pdf/**` and the sibling edge functions
   that compose statutory renderers under `supabase/functions/**`. It
   is forbidden anywhere under `src/**`. Enforced by
   `eslint-rules/no-raw-pdf-lib-in-app.js` and mirrored by an
   architecture test.
2. `bwip-js` and the raw `qrcode` node package may only be imported
   from `supabase/functions/_shared/**` (server barcode utility) plus
   `electron/**` (hardware ZPL/PDF417 helpers). They are forbidden
   under `src/**`. `qrcode.react` remains allowed. Enforced by
   `eslint-rules/no-direct-barcode-lib.js` and mirrored by an
   architecture test.

## Consequences

- New app-side surfaces requesting a printable barcode MUST call
  `printClient.print()` and receive the rendered artefact through the
  `document_artifacts` bucket rather than rasterising a PNG in the
  browser.
- New app-side PDF surfaces MUST route through `generate-document` so
  every emitted PDF is captured by the artefact store and served
  through the policy resolver.
- Existing sanctioned `qrcode.react` usages (`EtimsQRCode`,
  `MobileScannerDialog`, `ScannerSessionDialog`, `AdminInlineMfaSetup`,
  `TransactionSummaryView`, POS receipt `PreviewRenderer`) are
  unaffected — they render on-screen SVG only.
- Per-line opt-out: `// RENDERER-EXEMPT: <reason>` on the preceding
  line, matching the convention used by ADR-0063 guards. Reserved for
  vetted exceptions only; any usage must cite a documented reason.

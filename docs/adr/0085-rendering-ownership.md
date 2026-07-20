# ADR-0085 — Rendering ownership: which layer owns which byte

- Status: Accepted (2026-07-20)
- Related: ADR-0008, ADR-0026 (cross-app print router), ADR-0084 (Line AST)

## Context

Once the receipt pipeline converged on a single `Line[]` AST (ADR-0084),
we still needed an unambiguous rule for which module is allowed to emit
which physical bytes. Without this rule, incidents kept recurring:

- Components would import `pdf-lib` directly and render PDFs client-side,
  bypassing the server-side `_shared/pdf` helper (fonts, geometry,
  paging) and producing PDFs that disagreed with printed output.
- Component authors reached for `bwip-js` / raw `qrcode` to render
  barcodes on screen for a "preview" and inadvertently shipped a
  parallel rasteriser divorced from the printable barcode path.
- Ad-hoc `\x1B@` / `\x1DV` byte strings appeared in hooks and screens,
  bypassing `PrinterProfile` and the shared row producer.

## Decision

Rendering ownership is fixed by module:

| Byte kind                          | Sole owner                                             |
|------------------------------------|--------------------------------------------------------|
| PDF (all documents / receipts)     | `supabase/functions/_shared/pdf/**` via `generate-document` |
| ESC/POS command bytes              | `supabase/functions/_shared/escpos/**` (Line[] → bytes) |
| ZPL command bytes                  | `src/services/printing/**` + label driver layer        |
| Printable barcode / QR raster      | `printClient.print(...)` → server renderer             |
| On-screen barcode / QR (SVG only)  | `qrcode.react` (SVG component; not a printer)          |

Application code (`src/**` outside the sanctioned driver directories)
MUST NOT import `pdf-lib`, `bwip-js`, or the raw `qrcode` package, and
MUST NOT hand-construct ESC/POS or ZPL bytes.

## Consequences

**Positive**

- Every printed byte flows through one owner per medium, so paper
  geometry, fonts, and printer capabilities live in a single table.
- The application bundle stays free of heavy rasteriser dependencies
  (`pdf-lib`, `bwip-js`) — server does the work.
- Fixes to font metrics or barcode rasterisation ship once, everywhere.

**Negative / accepted costs**

- On-screen previews that want a raster (rather than SVG) must round-trip
  through the print router even in dev.
- Adding a new physical medium requires designating a single owning
  module before shipping the first byte.

**Guardrails (enforced)**

- ESLint rules `no-raw-pdf-lib-in-app`, `no-direct-barcode-lib`,
  `no-raw-zpl-outside-printing`, `no-raw-escpos-bytes`.
- Runtime mirrors: `adr-0085-rendering-ownership.test.ts`,
  `no-printservice-shim.test.ts`, `no-direct-window-print` /
  `no-document-print-shadow-path` ESLint rules.
- Per-line opt-out `// RENDERER-EXEMPT: <reason>` exists but is reviewed
  as a code-owner exception.

## Exemptions

- `src/services/hardware/drivers/**` and `electron/hardware/drivers/**`
  are transport layers and may hold the exact bytes coming off the wire.
- Test fixtures and byte-golden files under `src/test/**` and
  `*_test.ts` may embed raw bytes for assertion purposes.

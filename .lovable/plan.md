
# Thermal Receipt Rendering — Architecture Audit & Redesign Plan

## 1. What is actually in the code today

Tracing a single POS sale from event to paper reveals **five** independent
renderers that all claim to describe "the receipt", plus a duplicated
layout engine:

| # | Path | Where | Engine | Consumed by |
|---|------|-------|--------|-------------|
| 1 | `PreviewRenderer.tsx` | `src/lib/pos/receipt/renderers/` | HTML/JSX + Tailwind, freeform flexbox, QR via `qrcode.react` | `PostPaymentScreen` |
| 2 | `MonospacePreview.tsx` + `buildReceiptLines.ts` | `src/lib/receipt/preview/` | Shared column engine (`ColumnLayout` + `PrinterProfile`) | `ReceiptPreviewDialog` |
| 3 | `buildDocumentEscPos()` | `supabase/functions/_shared/escpos/builder.ts` | Same shared column engine (server copy) → ESC/POS bytes | Thermal printer |
| 4 | `generateDocumentPdf()` | `supabase/functions/_shared/pdfGenerator.ts` (+ `pdf/PdfBuilder`, `pdf/components/*`) | **Coordinate-drawn `pdf-lib`** — the A4 invoice pipeline, forced onto 58/80/40 mm | The "PDF receipt" the user is complaining about |
| 5 | `CustomerDisplayRenderer.ts` | `src/lib/pos/receipt/renderers/` | Bespoke text sink | Customer-facing display |

The layout engine itself (`ColumnLayout.ts`, `PrinterProfile.ts`) is
**physically duplicated** between `src/lib/receipt/engine/` and
`supabase/functions/_shared/receipt/engine/`. `ColumnLayout.ts` is
byte-identical, `PrinterProfile.ts` has already drifted.

## 2. Why the PDF looks worse than the preview

The on-screen previews (#1, #2) and the ESC/POS bytes (#3) either use the
shared column engine directly or an HTML analog of it. The PDF path (#4)
does **not**. It reuses the A4 invoice components (`drawBrandedHeader`,
`drawDocumentMeta`, `drawLineItemsTable`, `drawTotalsBlock`,
`drawNotesBlock`, `BrandedFooter` …) which:

- draw text at absolute `(x, y)` coordinates in `pdf-lib` units;
- were designed for a 595 pt (A4) canvas and only branch on a `density`
  flag when the page is ≤ 90 mm wide;
- share margins, gutters, column widths and line-heights across every
  document type — no per-paper measurement, no per-section owner, no
  wrap-aware column solver;
- lay out separators, meta blocks and totals independently of the item
  table, so any change in one block silently overlaps another on the
  narrow page.

The failure modes the user reports (text collisions, separators through
content, uneven spacing, unstable flow) are the deterministic consequence
of running a coordinate-based A4 renderer on a 48-column continuous
strip. They cannot be "styled out"; they must be reproduced from the
same source of truth that produced the preview and the ESC/POS bytes.

## 3. First-principles ownership (target model)

An enterprise ERP owns the receipt in exactly five layers, and every
render surface reads from the layer above it. **No layer skips down and
no layer is duplicated.**

```text
Business event  (POS sale, refund, payment, void)
      │
      ▼
Receipt DOCUMENT MODEL           <-- domain snapshot (already exists: ReceiptDocumentModel)
      │
      ▼
Receipt LAYOUT DEFINITION        <-- declarative sections + column specs
      │  (single registry keyed by document type + paper width)
      ▼
Flow LAYOUT ENGINE               <-- solves widths, wraps, measures, paginates
      │  (single: PrinterProfile + ColumnLayout + section runtime)
      ▼
Render TARGETS (thin adapters)
   ├─ ESC/POS bytes         (thermal printer)
   ├─ Monospace strip       (on-screen WYSIWYG preview)
   ├─ Thermal PDF           (email/download/archive, driven from the SAME rows)
   ├─ Customer display      (VFD/second screen)
   └─ Kitchen ticket        (already parallel — same engine)
```

Ownership rules:

- **Document model** owns identity, totals, tender, flags, snapshot
  linkage.
- **Layout definition** owns *what appears and in what order* — header,
  identity block, meta, cashier, customer, item table columns,
  discounts, taxes, totals, payments, change, eTIMS block, footer,
  legal. Paper width and font are inputs; the definition selects a
  layout variant from a registry.
- **Layout engine** owns typography, line-height, column solving, word
  wrap, separator placement, section spacing, page break / cut logic.
  Nothing above it deals with points, columns, or characters.
- **Render targets** own only the mapping from a laid-out row to their
  medium (ESC/POS byte, DOM node, PDF `drawText`, ZPL command).
- **Printer profile** owns paper width × font × margins × capabilities.
  It is the only thing that knows a physical printer.

This is the same partition Odoo (report engine → paperformat →
receipt template → printer), NetSuite (advanced PDF/HTML with paper
profiles) and Square (declarative "receipt spec" → three renderers)
converge on. We infer, not copy.

## 4. Concrete redesign

### 4.1 Consolidate the engine
- Delete the duplicated `src/lib/receipt/engine/*` copy. Serve the
  engine from **one** location (browser + Deno-safe) — the shared
  `_shared/receipt/engine/` becomes canonical and is imported by both
  the edge function and the browser via a thin re-export module.
  `ColumnLayout` and `PrinterProfile` become single-source.
- Add a `SectionRuntime` layer on top of `ColumnLayout` that owns:
  vertical rhythm (line-height in engine units, not px/pt), section
  gaps, rule/separator drawing rules, and continuation-row alignment.
  Coordinates disappear from every caller above this line.

### 4.2 Promote a single Receipt Layout Registry
- Move `_shared/receipt/layouts/` and `src/lib/receipt/layouts/` into
  one authored registry keyed by `(document_type, paper_width)` with
  named variants (`pos_receipt.compact_80`, `pos_receipt.compact_58`,
  `pos_receipt.narrow_40`, `kitchen_ticket.default_80`, …).
- Each layout is declarative: an ordered list of sections
  (`Header`, `Identity`, `Meta`, `Items`, `Discounts`, `Taxes`,
  `Totals`, `Payments`, `Change`, `Fiscal`, `Footer`, `Legal`) plus a
  `ColumnSpec` for the items table. No layout contains rendering code.
- `pickFittingLayout()` (already scaffolded) becomes the only chooser;
  `buildDocumentEscPos`, the monospace preview builder, the PDF
  renderer and the customer display all call it.

### 4.3 Rebuild the "thermal PDF" on the same rows
- The thermal PDF path stops calling `generateDocumentPdf` /
  `drawBrandedHeader` / `drawLineItemsTable` entirely.
- New `renderThermalPdf(layoutRows, profile)` walks the exact same
  `LineMeta[]` produced for the monospace preview and the ESC/POS
  byte stream, and emits each row into a `pdf-lib` page whose width =
  paper width and whose height = measured content height (continuous
  media, already supported by `PdfBuilder`).
- Font: a single embedded monospace TTF (thermal-appropriate metrics).
  Every measurement flows from the engine, not from `pdf-lib`.
- Result: a PDF that is a pixel-faithful facsimile of the preview and
  of the printer output. Separator collisions, uneven rhythm, unstable
  flow become **structurally impossible** because there is no
  coordinate math outside the engine.
- `generateDocumentPdf` remains the owner of A4/Letter/A5 documents
  (invoices, POs, statements). It is no longer routed for thermal
  widths; the coercer in `coercePaperRenderMode` is updated so any
  thermal paper × PDF combination lands in `renderThermalPdf`.

### 4.4 Retire the divergent HTML preview
- `PostPaymentScreen` migrates from `PreviewRenderer` (HTML/JSX
  free-flow) to `MonospacePreview` (engine-driven). QR / logo become
  engine-level `qr` / `image` row types rendered as SVG in the DOM
  target and as native ESC/POS commands in the printer target.
- `PreviewRenderer.tsx` is deleted after migration.

### 4.5 Information architecture (what customers see)
The layout registry codifies the following hierarchy per paper width,
tuned by the engine's rhythm rules, not by ad-hoc spacing:

1. Business identity (logo, legal name, address, tax id)
2. Document identity (title, number, timestamp)
3. Transaction metadata (cashier, register, customer)
4. Items table (product, qty × unit, line total; wraps into
   continuation rows aligned to the totals column)
5. Discounts / taxes (only when present, engine hides empty sections)
6. Totals (subtotal → discount → tax → **TOTAL** emphasised)
7. Tender / change
8. Fiscal / eTIMS block + QR
9. Footer text, return policy, legal
10. Cut marker (physical) or dashed rule (preview/PDF)

### 4.6 Cross-module consistency
- POS receipt, Sales receipt, Kitchen ticket, Payment receipt (AR),
  Vendor payment receipt: all switch to the same registry. Only their
  `document_type → layout variant` mapping differs; the pipeline is
  one.
- Architecture test extended: forbid any new `drawText` /
  coordinate-drawn PDF component from being called with a paper width
  ≤ 90 mm. Forbid any new preview component that does not consume
  `LineMeta[]` from the shared engine.

## 5. Delivery plan (implementation order)

1. **Freeze single engine** — collapse `src/lib/receipt/engine/*` into
   the shared package (re-export shim); reconcile drifted
   `PrinterProfile`. Extend engine with `SectionRuntime` (rhythm,
   separators, section gaps).
2. **Layout registry unification** — merge client + server layouts
   into one registry; add explicit `pos_receipt.{40,58,80}` variants
   with authored column specs.
3. **`renderThermalPdf`** — new module in
   `supabase/functions/_shared/receipt/pdf/`, driven by `LineMeta[]`.
   Wire it into `generate-document` for every thermal-width PDF
   request; route A4/Letter/A5 unchanged through `generateDocumentPdf`.
4. **Preview convergence** — replace `PreviewRenderer` usage in
   `PostPaymentScreen` with `MonospacePreview`; remove
   `PreviewRenderer.tsx`.
5. **Guard rails** — architecture tests (a) forbid coordinate PDF
   components at ≤ 90 mm, (b) forbid non-engine preview components,
   (c) forbid re-introducing a second engine copy.
6. **Golden tests per width** — 40 / 58 / 80 mm goldens for both the
   monospace preview and the new thermal PDF (screenshot the PDF,
   compare byte-stable text extraction), plus the existing ESC/POS
   goldens. Same fixture drives all three targets.
7. **Cleanup** — remove dead A4 branches from the thermal path
   (density switches in `PdfBuilder`, thermal-only margin overrides in
   `BrandedHeader`/`DataTable`/`NotesBlock`).

## 6. Non-goals (explicitly out of scope)

- Redesigning the visual look-and-feel of any specific receipt beyond
  what deterministic rhythm and column solving produce.
- Migrating A4 invoices/POs/statements off `generateDocumentPdf` —
  that pipeline is correct for its medium and stays.
- Changing fiscal (eTIMS) semantics, receipt titles, or the
  snapshot / reprint contract — those live in the document model and
  are already correct.
- Kitchen ticket byte format (already engine-driven; only benefits
  from the unified registry).

## 7. Success criteria

- Exactly **one** module builds `LineMeta[]` for a given
  `(ReceiptDocumentModel, PrinterProfile)`.
- Exactly **one** engine solves columns, wraps and paginates.
- Preview, PDF, ESC/POS bytes and customer display all diff-match on
  the fixture set at 40 / 58 / 80 mm.
- No `pdf-lib` `drawText` call is reachable from a thermal-width
  render.
- Removing a section from the layout definition removes it
  simultaneously from preview, PDF and printer.

---

## 8. Execution log (chronological status)

Each wave lands one horizontal slice of the target architecture and is
considered done only when (a) code merged, (b) tests green, (c) plan
updated. The **Next agent must first verify the previous wave using the
listed checks** before starting the next.

| Wave | Scope | Status | Verification |
|------|-------|--------|--------------|
| 1 | Shared row producer `_shared/receipt/lines.ts` (server-side) + `documentToInput.ts` adapter | ✅ Done | `deno test _shared/receipt/lines_test.ts` |
| 2 | `renderThermalPdf` + `generate-document` thermal PDF branch (headers `X-Print-Policy-Renderer: thermal-engine`) | ✅ Done | Curl `/generate-document` with `format:pdf, documentType:pos_receipt` → response has `X-Print-Policy-Renderer: thermal-engine` |
| 3 | `PostPaymentScreen` migrated to `MonospacePreview`; architecture-guard test extended | ✅ Done | `bunx vitest run pos-receipt-renderer-contract` |
| 4 | `PreviewRenderer.tsx` **deleted**; barrel exports cleaned; guards flipped to assert absence | ✅ Done | `bunx vitest run pos-renderer-ownership pos-receipt-renderer-contract` |
| 5 | New `_shared/escpos/renderLinesEscPos.ts` emitter (CP858, per-row bold/large/align, native QR); 10 Deno tests locking preamble, LF-per-row, state reset, align transitions, native QR gating, feed+cut, transliteration | ✅ Done | `supabase test _shared/escpos/renderLinesEscPos_test.ts` (10/10 pass) |
| **6a** | **POS PDF always routes through thermal engine — no more A4 fallback for `pos_receipt`.** `generate-document` now resolves the render width from `pos_receipt_settings.paper_size` → policy → 80mm, and drops the previous `isThermalWidth &&` guard for POS receipts. Response advertises `X-Print-Policy-Effective-Paper`. | ✅ Done (this wave) | Curl `/generate-document {documentType:'pos_receipt', format:'pdf'}` on an org whose print policy resolves to A4 → response now has `X-Print-Policy-Renderer: thermal-engine` and `X-Print-Policy-Effective-Paper: 80mm`; the downloaded PDF is a thermal strip, not an A4 invoice |
| 6b | Retire `_shared/escpos/builder.ts` internals — reimplement as thin shim over `buildReceiptLines` + `renderLinesEscPos`; migrate/replace the byte-fingerprint tests in `builder_test.ts` (~40 assertions) with structural checks driven by `LineMeta[]`. | ⏳ **Pending — next milestone** | Byte-parity golden between old builder output and new emitter for the fixture set (`goldenDoc` at 80/58/40mm), then swap and delete legacy internals |
| 7 | Golden diff tests per width (40 / 58 / 80 mm) across the three targets (monospace preview, thermal PDF, ESC/POS bytes) from a single fixture | ⏳ Pending |
| 8 | Delete dead A4 branches from the thermal path (`PdfBuilder` `density: "narrow"` code, thermal margin overrides in `BrandedHeader` / `DataTable` / `NotesBlock`) | ⏳ Pending |

### 8.1 Active phase

**Wave 6b — ESC/POS builder retirement.** Wave 6a shipped the
user-visible fix (POS "Save PDF" no longer regenerates the A4 invoice
look for pos_receipt); the ESC/POS byte generator is still the legacy
procedural walker in `_shared/escpos/builder.ts`. Retiring it requires a
byte-parity golden gate before the swap.

### 8.2 Instructions for the next agent

Do these **before** starting Wave 6b:

1. **Verify Wave 6a as shipped**:
   - Read `supabase/functions/generate-document/index.ts` around the
     thermal PDF branch (search for `routeThroughThermalEngine`).
     Confirm the condition is `isReceiptLike && !isStatement &&
     (isThermalWidth || documentType === "pos_receipt")` — i.e. POS
     receipts always route through `renderThermalPdf` regardless of
     policy paper.
   - Confirm the response sets `X-Print-Policy-Renderer:
     thermal-engine` and `X-Print-Policy-Effective-Paper`.
   - Sanity-run: from the POS "Save PDF" surface in
     `ReceiptPreviewDialog.tsx`, save a receipt for a transaction and
     open the downloaded PDF — it must be a continuous thermal strip
     structurally identical to the on-screen `MonospacePreview`.
   - Do NOT proceed if you observe an A4-sized PDF; that means the
     branch was bypassed or the client is passing `paperFormat: 'a4'`
     explicitly (the "no printer" fallback path in
     `handlePrint()` still forces A4 for browser-native print — that
     is intentional and must not be changed here).

2. **Then start Wave 6b (retire legacy ESC/POS builder)**:
   - Add a Deno test that fingerprints `buildDocumentEscPos(goldenDoc)`
     and `renderLinesEscPos(buildReceiptLines(documentToReceiptInput(goldenDoc)))`
     at 40/58/80mm. Adjust `documentToReceiptInput` / `lines.ts` until
     the two fingerprints match on the fixture set (allowing only
     documented byte-level deltas — record any diffs in the plan).
   - Once green, replace the body of `buildDocumentEscPos` in
     `_shared/escpos/builder.ts` with:
     ```ts
     const input = documentToReceiptInput(doc, { settings: opts.receiptSettings, ... });
     const rows = buildReceiptLines(input);
     return renderLinesEscPos(rows, { caps: opts.capabilities, cut: opts.cut });
     ```
     Delete the ~800 lines of procedural section walking, CP858 map,
     and per-block emitters.
   - Update `builder_test.ts` byte-fingerprint tests: keep the fixture,
     re-baseline the fingerprints in ONE commit (recorded in this plan
     under a "Byte-parity re-baseline" heading with the old→new hashes
     for auditability), and convert per-block assertions to structural
     `LineMeta[]` checks where possible.
   - Do NOT proceed to Wave 7 until every test file listed in the Wave
     5 grep output (`builder_test.ts`, `blocks_test.ts`,
     `line_width_clamp_test.ts`, `escposBuilder.test.ts`,
     `escpos-parity_test.ts`) is green against the shim.

3. **Then start Wave 7 (goldens per width)** — only after Wave 6b is
   done. A single fixture drives all three targets; diverging outputs
   are architecture regressions, not test bugs.

**Do not** jump to Wave 8 (dead-code deletion in A4 pipeline) before
Wave 6b — the ESC/POS shim proves the row producer covers every field
the legacy builder covered; deleting A4 thermal branches earlier risks
leaving unreachable fixtures without a canary to catch them.

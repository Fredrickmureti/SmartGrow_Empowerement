# Document Presentation Architecture — audit findings and consolidation plan

## What the audit found (verified in code and data)

The ERP has **three** parallel document-presentation pipelines, not one.

1. **Canonical engine** — `supabase/functions/_shared/receipt/lines.ts` produces a
   medium-neutral `Line[]` AST from `(settings, company, transaction)`;
   `renderThermalPdf`, `renderLinesEscPos` and the browser `MonospacePreview`
   all consume it. This is the correct architecture and is what the POS
   **preview** you screenshotted uses.
2. **Legacy A4/thermal coordinate renderer** — `supabase/functions/_shared/pdf/**`
   with its own `LineItemsTable` (wide grid + a second hand-drawn
   `drawLineItemsNarrow` thermal layout) fed by a *different* column authority,
   `documents/lineItemProfiles.ts` (mirrored in `src/lib/documents/`).
3. **Snapshot render engine** — `render-document` +
   `_shared/rendering/**`, fed by 18 hand-written per-module snapshot builders
   in `src/services/documents/snapshots/*`. Each module decides its own
   presentation fields. This is the path the real printer uses.

So there are two competing "single sources of truth" for line-item columns
(`lineItemProfiles.resolveLineItemColumns` vs the receipt
`LAYOUT_REGISTRY`/`assembleItems`), two settings mergers (`src/lib/pos/…` and
`_shared/pos/…`), four mirrored client/edge copies of presentation code, and a
1,100-line legacy `escpos/builder.ts` alongside the new `Line[]` emitter.

### Why the thermal receipt differs from the preview (root cause, confirmed)

- `renderAstToEscPos` reads receipt settings from `context.options.receiptSettings`.
  **No client caller ever sets that option** (`rg receiptSettings src/services` →
  only the snapshot builder). So it is `null`.
- `documentToReceiptLines` then builds `rs = { ...(null ?? {}) }` → `{}` and passes
  it as `overrides.settings`. In `documentToReceiptInput` the resolution is
  `overrides.settings ?? storedRs` — an **empty object is not nullish**, so the
  snapshot's `pos_receipt_settings` is discarded and the engine falls back to
  defaults → `compact` layout (qty | name | total), which is exactly the printed
  output. The operator's saved `item_display_format = "two-lines"` (verified in
  `pos_settings`) never reaches the printer.
- `buildPosReceiptSnapshot` reads `txn.subtotal_amount` / `txn.total_amount` /
  `txn.receipt_number` / `txn.transacted_at`, but the frozen
  `pos_receipt_snapshots.payload.transaction` uses `subtotal` / `total` /
  `transaction_number` / `created_at`. Verified against the real row for
  POS1-260801-0002 (subtotal 240, total 240) → snapshot emits 0, which is why
  paper shows `Subtotal 0.00 / TOTAL 0.00` while payments show 240.00.

These are symptoms of the architecture problem, not the problem itself.

## Target architecture

```text
Business module            → owns data only (document_records + snapshot)
Document Presentation      → resolves ONE profile per (kind, medium, scope)
Line[] AST engine          → structure, columns, ordering, totals, blocks
Renderers (PDF/ESC-POS/    → geometry only: fonts, cells, page breaks, bytes
  ZPL/HTML/preview)
```

**Presentation profile** becomes a first-class, scoped record covering: paper /
media class, typography and density, line-item layout (which of qty, unit price,
discount, tax, UoM/packaging, SKU appear and in what shape), header/footer,
branding, totals, signatures, legal text, barcode/fiscal blocks. Scope
precedence: `organization → business → branch → register/document-kind override`.
POS keeps only an **override**, not its own architecture.

## Work plan

**1. One presentation authority**
- Introduce `documents/presentation/` (shared edge module + one thin browser
  re-export, no more byte-mirrored copies): `PresentationProfile` type,
  `resolveProfile(kind, mediaClass, scope)`, and one `resolveLineItemLayout`
  that supersedes both `lineItemProfiles.ts` and the receipt `LAYOUT_REGISTRY`
  legacy enum mapping. Migrate `pos_settings.receipt_settings` and
  `businesses.receipt_settings` into the profile store; keep POS as a scoped
  override row.

**2. One structure producer**
- `lines.ts` becomes the only structure producer for every medium, driven by the
  resolved profile. Wide media (A4/Letter/HTML) get a `columns` presentation of
  the same AST instead of a separate hand-drawn table.
- Fix the settings-resolution defect properly: profiles are resolved once, in the
  engine, from the document record + scope — renderers stop accepting a
  `receiptSettings` bag at all.

**3. One document data contract**
- Replace the 18 hand-written snapshot builders' presentation-bearing fields with
  a generated canonical `DocumentSnapshot` (header, parties, lines, totals,
  payments, fiscal, notes/terms). Field names come from the contract, so the
  `subtotal_amount` class of bug cannot recur. Add a contract test per kind.

**4. Delete legacy paths (no fallbacks)**
- `_shared/escpos/builder.ts` (`buildDocumentEscPos`) and its section logic.
- `documents/lineItemProfiles.ts` (both copies) and `drawLineItemsNarrow`.
- Thermal/receipt branches inside `generate-document/index.ts`; the function is
  reduced to a transport adapter over `render-document`, or removed once callers
  move.
- Mirrored client copies: `src/lib/receipt/items.ts`, `src/lib/receipt/layouts`,
  `src/lib/receipt/engine/*`, `src/lib/pos/mergeReceiptSettings.ts`,
  `src/lib/documents/lineItemProfiles.ts` — replaced by one shared module.
- The parity tests that exist only to police those duplicates.

**5. One workspace (UX)**
- New `Settings → Documents & Printing` workspace: left rail of document kinds
  (Sales, Purchasing, POS, Inventory/WMS, HR & Payroll), per kind a media tab
  (A4 / 80mm / 58mm / 40mm / Email), and a live preview using the same engine
  the printer uses. Editing line-item presentation, typography, headers,
  footers, totals, legal text happens only here.
- `Company Settings → Receipts` and `POS Settings → Receipts` are removed; POS
  gets a single "Register override" entry that opens the same workspace scoped
  to the register. One place to answer "where do I change how invoices show
  items?"

**6. Guardrails**
- ESLint + architecture tests: no module outside `documents/presentation/**` may
  decide columns, typography or spacing; no renderer may read raw settings; no
  new mirrored copies; golden-byte tests for 40/58/80 mm and A4 per kind, and a
  preview↔ESC/POS↔PDF parity test asserting identical `Line[]` for one input.

## Sequencing

1. Contract + profile module + engine wiring (behaviour-preserving), with the
   preview/print parity test failing first, then green.
2. Migrate snapshots to the canonical contract, kind by kind, deleting each
   legacy branch as its kind lands.
3. Wide-media (A4) migration onto the same AST.
4. Workspace UI + settings migration, delete old screens.
5. Remove `generate-document` legacy renderers and dead mirrors; enable guardrails.

## Notes

Immediate visible outcome after step 1: printed thermal receipts match the POS
preview exactly (correct layout, correct subtotal/total), and every other
thermal document — estimates, sales orders, invoices, POs, delivery notes,
returns — inherits the same qty × unit-price presentation from one profile.

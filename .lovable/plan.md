# Enterprise Document Presentation — Audit Findings & Consolidation Plan

## What "document presentation" means here

In SAP/Dynamics/NetSuite/Odoo the printable-document stack is split four ways, and the split is the whole point:

| Layer | Owns | Must NOT own |
|---|---|---|
| Business module | the record and its numbers | anything visual |
| Document model | a frozen, paper-agnostic snapshot | fonts, columns, paper |
| **Presentation profile** | which fields/columns appear, order, typography, spacing, branding, headers/footers, totals, signatures, legal text | how to draw a glyph |
| Renderer (PDF / ESC-POS / ZPL / HTML) | geometry for one medium | *which* fields appear |

The line-item question that triggered this audit resolves cleanly under that model: whether Unit Price, Discount, Tax, UoM or Packaging appear is **never** a per-module or per-template decision. It is a reusable **line-item presentation profile** selected by document kind + context (a delivery note suppresses amounts because its profile says so, not because its generator hardcodes `hide_amounts: true`).

## Audit result: the ERP has three presentation stacks, not one

1. **Legacy imperative PDF stack (what actually prints every commercial document today).**
   `generate-document/index.ts` (3,587 lines, 18 per-doctype fetchers) → `_shared/templateRenderer.ts` → `_shared/pdfGenerator.ts`, which calls header → recipient → meta → line items → totals → notes in a **hardcoded order**. Theme is a single hardcoded object, `_shared/pdf/themes/accountantMono.ts`. Presentation is persisted in `document_templates`, whose `template_type` constraint only admits `invoice | estimate | proforma | credit_note | receipt | purchase_order` — so sales orders, delivery notes, GRNs, returns, statements and warehouse documents **have no configurable presentation at all**. Goods receipts literally borrow the purchase-order template by comment.

2. **POS/thermal stack — a genuinely better model, walled off in POS.**
   `ReceiptTheme` (`businesses.receipt_theme` / `pos_registers.receipt_theme`) already expresses paper, density, typography, branding, section order, per-section field visibility, formatting and a pluggable `LayoutTemplate` registry with `compact | detailed | tabular | tabular_sku` column presets. This is the presentation-profile concept the rest of the ERP lacks — it is simply scoped to receipts.

3. **AST engine (ADR-0084) — architecturally correct, barely adopted.**
   `render-document` → `_shared/rendering/engine.ts` with medium-neutral blocks and `document_kinds` / `document_template_ast` / `document_theme` / `document_header_footer`. Only ZPL labels and payslips genuinely use it; for every other kind `renderAstToPdf` is an adapter that calls the legacy imperative `generateDocumentPdf` — so the AST currently controls *whether* a section fires, not *how* it lays out.

Consequences today: two independent typography/branding models with zero shared code, three overlapping presentation tables, line-item columns decided in three unrelated places (`buildColumns()`, `drawLineItemsNarrow()`, `LayoutTemplate.columns()`), and ten document types with no presentation surface at all.

## Direction

Make the ADR-0084 AST engine the **only** presentation architecture. `ReceiptTheme`'s richness becomes the shape of the unified theme; the legacy PDF stack is deleted, not wrapped.

```text
Business module ──▶ Document snapshot (frozen, paper-agnostic)
                          │
             Presentation profile resolver
        (kind + scope ladder: branch ▸ org ▸ tenant ▸ system)
                          │
        ┌─────────────────┴─────────────────┐
   Theme + header/footer            Block AST (incl. line-item profile)
        └─────────────────┬─────────────────┘
                 Medium renderers
            PDF · ESC/POS · ZPL · HTML
```

## Steps

**1. Unified presentation model.** Extend `document_theme` to carry the full `ReceiptTheme` concern set (paper, density, typography, branding, section visibility, formatting, compliance) as one schema serving A4 and thermal alike. Fold `accountantMono` into a seeded `system` theme row so the current A4 output is byte-identical on day one. Migrate `businesses.receipt_theme` / `pos_registers.receipt_theme` and every `document_templates` row into `document_theme` + `document_template_ast` rows; add a register scope tier to the ladder so POS keeps per-register overrides.

**2. Line-item presentation profiles.** Introduce a first-class profile (column set, order, widths, visibility, grouping, UoM/packaging, amount suppression, narrow-paper collapse) referenced by the `table` block instead of the opaque `preset: "line_items"`. Seed named profiles — `commercial_full`, `commercial_no_amounts` (delivery/transfer/adjustment), `procurement`, `retail_compact`, `retail_detailed`, `statement` — and assign per document kind. This single move replaces `buildColumns()`, `drawLineItemsNarrow()` and the POS `LayoutTemplate` column functions.

**3. AST-first PDF renderer.** Replace the interior of `renderAstToPdf` so it walks the block list and lays out from the theme, using the existing `_shared/pdf/components/*` primitives as pure drawing helpers with no ordering knowledge of their own. Point the ESC/POS renderer at the same blocks and profiles, keeping `PrinterProfile`/`ColumnLayout` as the monospace geometry solver.

**4. Migrate every document kind.** Seed `document_kinds` + AST for quotation, estimate, proforma, sales order, delivery note, invoice, credit note, purchase order, vendor bill, goods receipt, sales/purchase return, customer & vendor statements, legal recipient statement, stock adjustment/transfer, POS receipt, drawer slip, kitchen ticket, payslip, HR letters, labels. The 18 fetchers move to a snapshot-builder module (data only); each is verified against golden byte output before its legacy path is cut.

**5. Delete the legacy stacks.** Remove `generate-document/index.ts`'s render path, `_shared/templateRenderer.ts`, imperative `generateDocumentPdf`, `drawLineItemsNarrow`, the receipt `LayoutTemplate` registry, and drop `document_templates`. No fallbacks, no shims.

**6. One presentation workspace (UX).** Today a user configures receipt appearance in Settings → Company → Receipts, print policy in Platform → Hardware → Output Policies, invoice fields in Settings → Company → Templates, with no cross-links. Replace with a single **Document Presentation** area: a list of document kinds → per-kind editor (Layout, Line Items, Typography & Spacing, Branding, Header/Footer, Totals, Signatures, Legal Text, Attachments) with a live preview at the target paper size for every kind, not just receipts. `DocumentTemplateSettings`, `DocumentTemplateBuilder`, `ReceiptSettings`, `ReceiptSectionEditor` are deleted; the shared `MonospacePreview`/`buildReceiptLines` preview generalises to a medium-aware preview driven by the same engine. Output policies stay in Hardware (transport is a different concern) but are deep-linked from each kind.

**7. Guardrails.** ESLint + architecture tests: no imports of the deleted modules, no per-module column lists, no theme constants outside the theme resolver, every `document_kinds` row must resolve to an AST, and byte-golden tests per kind.

## Technical notes

- Snapshots stay frozen; presentation is resolved at render time so reprints of historical documents can be reproduced by pinning the profile version on the artifact.
- Migration is per-kind behind the existing artifact ledger, so each kind flips only after its golden comparison passes; the legacy code is removed in step 5 once all kinds are flipped, within this work — not deferred.
- Statutory-pinned documents (ADR-0008) keep `assertStatutoryPaper("a4")`; their profiles are marked non-overridable in the resolver rather than bypassing it.
- `document_print_policies` and the print/transport layer are untouched.

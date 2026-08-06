# Sales & Purchases Document Workspace — Line Editor Consolidation

Authoritative status of the document-workspace refactor. Update after every implementation.

## Active phase

**Phase 8 — Editable line editors (Sales + Purchases): COMPLETE.**

## Completed and verified

**Phases 1-7 — Read-only document surfaces**
- Canonical document descriptors in place.
- Container-adaptive read-only `LineItemsGrid` shared by every record page.
- All outlier sales and purchase record pages migrated.

**Phase 8 — Editable line engine**
- `src/design-system/records/EditableLineItemsGrid.tsx` — measurement engine, column
  demotion, add/remove affordances, footer + toolbar slots.
- Shared rows under `src/components/documents/lines/` (promoted out of `components/sales`):
  - `PricedLineRow` — item / qty / price / tax / total (+ `PRICED_LINE_COLUMNS`,
    `PRICED_LINE_COLUMNS_NO_TAX`, `hideProductPicker`, `extra` slot).
  - `DeliveryNoteLineRow` — ordered vs delivered quantities, packaging.
  - `SalesReturnLineRow` — condition + `max_quantity` clamping.
  - `RequestLineRow` — demand-side documents (item / qty / indicative price).
  - `RequisitionLineRow` — description / qty / est. price / suggested supplier / need-by.
  - `ContractLineRow` — description / unit price / ceiling qty / ceiling value.

**Sales forms migrated (create + edit)**: Invoices, Estimates, Sales Orders, Credit Notes,
Proforma, Delivery Notes, Sales Returns.

**Purchase forms migrated (create + edit)**: Purchase Orders, Bills, Vendor Credit Notes,
Purchase Returns, RFQs, Requisitions (create), Contracts (create).

**Verification**: `tsgo --noEmit` clean. No `grid-cols-12` or `<Table>` line editor
remains anywhere under `src/features/sales` or `src/features/purchases`.

## Pending

**Phase 9 — Finance & Inventory document forms**
1. Audit remaining line editors outside Sales/Purchases: payments allocation tables,
   journal entry lines, stock adjustments/transfers, goods receipts.
2. Migrate them onto `EditableLineItemsGrid`, adding at most one new row component per
   genuinely distinct column contract (reuse `PricedLineRow` / `RequestLineRow` first).
3. Retire any remaining bespoke line editors and their orphaned cell components.

**Phase 10 — Hardening**
- Row-level memo audit (all handlers `useCallback`-stable).
- Remove `// @ts-nocheck` from migrated document form files, file by file.
- Add regression coverage for the measured grid at narrow container widths.

## Next task

Start Phase 9 step 1: inventory the non-sales/non-purchase line editors before writing code.

## Instructions for the next agent

1. **Verify before building.** Confirm Phase 8 claims independently:
   - `rg -l "grid-cols-12" src/features/sales src/features/purchases` returns nothing.
   - `npx tsgo --noEmit` is clean.
   - Spot-check two migrated forms in the preview at both a narrow and a wide container:
     demoted columns must remain editable, totals must recompute on qty/price/tax edits.
2. **Then resume at the "Next task" above** — do not start unrelated work, and do not
   leave a document type half-migrated.
3. **Update this file** immediately after each implementation so it stays authoritative.

## Technical notes

- Row components live in `src/components/documents/lines/` and are shared across domains.
  Never re-introduce a domain-local line editor.
- Rows are `memo`-wrapped: parents MUST pass `useCallback`-stable `onPatch`,
  `onProductSelect`, `onAddRow`, `onRemoveRow` and `formatCurrency`.
- Quantities are always base units; packaging/UoM provenance rides on
  `packaging_id` / `display_uom_id` / `display_quantity` via `PackagedQtyCell`.
- Tax handling stays in the form's patch handler, not in the row.

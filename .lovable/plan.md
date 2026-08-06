# Enterprise Document Workspace — Architecture Refactor

Authoritative status. Update this file at the end of every implementation step.

## Goal

One canonical record-interaction layer (List → Peek → Object Page) in
`src/design-system/records/`, consumed by every transactional module. Feature
modules map rows to a descriptor; they never decide layout, status colour,
totals ordering or history rendering.

## Currently active

**Phase 8 — editable line-item grid.** In progress: the design-system grid is
built and the Invoice create/edit forms are migrated. Remaining: estimate,
sales-order, credit-note, delivery-note and return forms.

## Phase status

| # | Phase | State |
|---|-------|-------|
| 1 | Canonical document contract (`DocumentRecordView`) | Done, verified |
| 2 | Status + money registries | Done, verified |
| 3 | Container-adaptive line items (read surfaces) | Done, verified |
| 4 | Migrate outliers (Invoice, Estimate, Sales Order) | Done, verified |
| 5 | Lifecycle strip + audit-backed activity | Done, verified |
| 6 | Promotion to `@/design-system/records` | Done, verified |
| 7 | Architecture ratchets | Done, verified |
| 8 | Editable line-item grid (create/edit forms) | In progress — engine done, Invoice migrated |
| 9 | Extend the layer beyond Sales (Purchases, Finance) | Not started |

## Implemented and verified

- **Descriptor** — `records/types.ts`. `RecordScaffold` (page) and
  `PeekScaffold` (drawer) are two projections of it; shared content lives in
  `DocumentWorkspace.tsx`, so peek/full parity is structural.
- **Status vocabulary** — `documentStatus.tsx`. One label + tone per status,
  with per-kind overrides. Every local `STATUS_TONE` / `TONE` / `LABEL` map in
  `src/features/sales` is gone.
- **Money** — `money.ts` derives the totals ladder (Subtotal → Discount → Tax
  → Shipping → Total → Paid → Balance) once.
- **Line items** — `LineItemsGrid.tsx` measures its container
  (`ResizeObserver`) and demotes low-priority columns to a secondary line.
  The `min-w-[720px]` floor that forced horizontal scroll inside the drawer is
  removed; scrolling is now a measured last resort.
- **Outliers migrated** — `invoiceView.tsx`, `estimateView.tsx`,
  `salesOrderView.tsx` each feed both their page and their peek.
- **Lifecycle** — `DocumentLifecycleStrip.tsx` over `get_document_lineage`
  (estimate → proforma → sales order → delivery note → invoice).
- **Activity** — `useDocumentActivity.ts` merges `audit_logs` and
  `document_emails`, resolves actors through one batched `profiles` lookup and
  renders automatically whenever the descriptor carries `documentId`. The old
  two-entry synthetic lists are deleted; non-audited milestones (e-signature,
  conversion) go through `activityExtra`.
- **Editable line items (Phase 8, partial)** — measurement engine extracted to
  `records/adaptiveColumns.ts` and shared by `LineItemsGrid` (read) and the new
  `records/EditableLineItemsGrid.tsx` (write). The editable grid owns the
  chrome (header, remove, add, footer, toolbar) and hands each row the resolved
  layout via `renderRow`, so per-row `React.memo` still holds (barcode scanning
  stays O(1) per scan — pinned by `src/test/sales/invoice-line-row-memo.test.tsx`).
  `InvoiceLineRow.tsx` now renders grid cells + a full-width extras line
  (stock status, analytics, lot/serial tracking) and exports the shared
  `INVOICE_LINE_COLUMNS` contract. `InvoiceCreatePage` / `InvoiceEditPage` are
  migrated: the `<Table className="min-w-[600px]">` and the duplicated mobile
  card stack are both deleted — one editor for every container width.
  `src/test/setup.ts` now stubs `ResizeObserver` as a real constructor.
- **Ratchets** — `src/test/architecture/document-workspace-canonical.test.ts`
  (7 tests, passing) fails CI on: local status maps, hand-rolled
  `RecordShell` / `DetailSheet` record surfaces, synthetic `activity:` arrays,
  duplicate line-item renderers, and hard `min-w-[NNNpx]` on record surfaces.

Verification performed: `tsgo --noEmit -p tsconfig.app.json` clean; the
canonical ratchet suite passes. Two failures in
`src/test/architecture/wms-phase3.test.ts` and `wms-phase4c.test.ts` are
pre-existing warehouse guards, unrelated to this work.

## Pending

1. **Phase 8 remainder — migrate the other document forms.** Still on bespoke
   `<Table>` line editors: estimate, sales-order, credit-note, delivery-note
   and sales-return create/edit pages. Each needs a `*_LINE_COLUMNS` contract
   plus a memoized row component mirroring `InvoiceLineRow`. Do not leave the
   module half migrated.
2. **Phase 9 — extend beyond Sales.** Purchases (bills, purchase orders) and
   Finance (payments, journal entries) still have partially migrated record
   surfaces. Migrate module by module, in that order.

## Next milestone

**Finish Phase 8** (remaining five forms), then Phase 9. Do not start Phase 9
before every Sales document form is on the editable grid.

## Instructions for the next agent

1. **Verify before extending.** Run `npx tsgo --noEmit -p tsconfig.app.json`
   and `npx vitest run src/test/architecture/document-workspace-canonical.test.ts`.
   Then read `src/design-system/records/DocumentWorkspace.tsx`,
   `types.ts` and `useDocumentActivity.ts` and confirm: no feature module
   renders document content outside the projections; no descriptor field is
   consumed by only one projection; the activity feed's `ENTITY_TYPE` map
   still matches the `entity_type` values written by the audit triggers
   (`select distinct entity_type from audit_logs`) — a kind missing from that
   map yields a silently empty feed, which is the main regression risk here.
2. **Verify the Phase 8 slice already shipped** before extending it: run
   `npx vitest run src/test/sales/invoice-line-row-memo.test.tsx` (memo
   contract) and `src/test/architecture/outbound-lot-serial-ui.test.ts`
   (lot/serial pickers still mounted on the invoice line), then open
   `/sales/invoices/new` at a narrow and a wide width and confirm the grid
   demotes Tax % / Price instead of scrolling, and that description, packaging,
   analytics and tracking are all reachable.
3. **Then resume at the Phase 8 remainder** as scoped above — estimate,
   sales order, credit note, delivery note, sales return — reusing
   `EditableLineItemsGrid` + `EditableLineRowCells`.
4. **Do not** start unrelated work (warehouse, POS, payroll) in the same pass,
   and do not relax a ratchet to make a change pass; change the code instead.

# Enterprise Document Workspace — Verification Verdict & Remaining Phases

## Phase 1 — Verification of the previous engineer's handover

I checked the claims directly against the code rather than the log.

| Claim | Verdict |
|---|---|
| One descriptor (`DocumentRecordView`) with two projections | Confirmed — `src/design-system/records/{types.ts,RecordScaffold,PeekScaffold,DocumentWorkspace}`. |
| Status + money vocabularies centralised | Confirmed — `documentStatus.tsx`, `money.ts`; no local status maps in Sales/Purchases/Finance/Inventory record surfaces. |
| Container-adaptive line grids, no width floors | Confirmed — `LineItemsGrid` + `EditableLineItemsGrid` both on `adaptiveColumns.ts` (`ResizeObserver`), no unconditional `min-w-[…px]`. |
| Sales + Purchases + Finance + Inventory line editors migrated | Confirmed — 20 create/edit pages consume `EditableLineItemsGrid`; no Sales form retains `grid-cols-12` or `<TableHead>` line editors. |
| "Only VendorStatementRecordPage remains off-protocol" | **Stale — already fixed.** It now renders `RecordScaffold` from a shared `vendorStatementView` descriptor, and the peek consumes the same hook. |
| Ratchet suite green | Confirmed — `document-workspace-canonical.test.ts` 10/10. |
| Typecheck clean | Confirmed — `tsgo --noEmit -p tsconfig.app.json` reports nothing. |

No inflated claims found. The handover's one outstanding item is closed.

Genuinely still open (verified by reading the files, not the log):

1. **Downstream lifecycle traversal is missing.** `DocumentLifecycleStrip`
   stops at Invoice: its `STEPS` array is quotation → proforma → sales order →
   delivery → invoice, and `get_document_lineage` resolves only those five.
   The parent prompt requires a controller to walk Invoice → Payment →
   Journal Entry → Reconciliation → Credit Note → Return → Collections. The
   data to do it exists (`payment_allocations.invoice_id`,
   `journal_entries.source_type/source_id`, `bank_reconciliation_matches`,
   `credit_notes.invoice_id`, `sales_returns.invoice_id`); nothing surfaces it.
2. **The ratchet does not close the form gap.** It asserts that *migrated*
   forms are clean, but a brand-new create page with an inline `grid-cols-12`
   line editor or a `<Table>` of line rows would pass CI today.
3. **Collections has no backing table** (no `collections`/`dunning` tables in
   the schema), so lifecycle must express it as a derived state on the
   invoice — a receivable position — not as a fake linked document.

## Phase 10 — Downstream lifecycle (the settlement half)

Extend the chain so the strip covers the full order-to-cash spine.

- New migration adding `get_document_settlement_lineage(p_doc_type, p_doc_id)`:
  same tenant guard as the existing RPC (`user_can_access_business`), read-only,
  `STABLE SECURITY DEFINER`, `GRANT EXECUTE … TO authenticated`. Returns, for an
  invoice anchor: `payments[]` (via `payment_allocations`, excluding voided),
  `journal_entry` (`source_type='invoice'`), `reconciliation` state for the
  matched bank lines, `credit_notes[]`, `returns[]`, plus a derived
  `collections` position (overdue bucket + balance) rather than a document.
- `DocumentLifecycleStrip` gains a second row — the settlement segment — fed by
  the new RPC. Upstream steps stay single-instance; downstream steps are
  cardinal (many payments, many credit notes), so they render as a count-badged
  node that expands into a linked list rather than one chevron per row.
- Unrealised downstream steps stay visible and dimmed: "no payment yet" is the
  single most useful fact on an unpaid invoice.
- Existing RPC untouched; the strip composes the two so no upstream regression
  is possible.

## Phase 11 — Close the ratchet gap

Extend `document-workspace-canonical.test.ts` so it fails when:

- any Sales/Purchases/Finance create/edit page renders line rows through an
  inline `grid-cols-12` block or a `<TableHead>` instead of
  `EditableLineItemsGrid` (allowlist only genuinely non-line tables);
- a record surface renders a lifecycle chain of its own instead of
  `DocumentLifecycleStrip`;
- a settlement-linked document (payment, credit note, return) record page ships
  a bespoke "related documents" list rather than the shared relationship panel.

## Phase 12 — Verification

- `tsgo --noEmit -p tsconfig.app.json` clean.
- `document-workspace-canonical.test.ts` plus the new guards green.
- Playwright pass on an invoice with payments, a credit note and a return, at
  drawer width and desktop width: the settlement row renders, links resolve,
  and no horizontal scroll appears in the peek.

## Technical notes

No new dependencies. One additive migration (a read-only RPC + grant); no schema
changes, no writes. All new UI composes existing design-system record
primitives; the lifecycle strip stays the single lifecycle renderer for every
module that inherits the workspace.

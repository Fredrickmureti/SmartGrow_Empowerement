# Document Workspace — Verification Verdict, then Phases 9 & 10

## Phase 1 — Independent verification of the previous engineer's claims

Every claim was re-checked against the code, not the log.

| Claim | Verdict |
|---|---|
| Canonical descriptor + one renderer for page and drawer | Confirmed. `src/design-system/records/types.ts` defines `DocumentRecordView`; `RecordScaffold` and `PeekScaffold` both project it through `DocumentWorkspace.tsx`. No second renderer. |
| Container-adaptive read-only line grid | Confirmed. `LineItemsGrid` + `adaptiveColumns.ts`, no fixed min-width floor. |
| Status and money registries | Confirmed. `documentStatus.tsx`, `money.ts`. |
| Lifecycle strip + audit-backed activity | Confirmed. `DocumentLifecycleStrip.tsx`, `useDocumentActivity.ts`. |
| Phase 8: editable line engine, all Sales + Purchases forms migrated | Confirmed. `EditableLineItemsGrid` plus shared rows under `src/components/documents/lines/`. A search for `grid-cols-12` line editors under `src/features/sales` and `src/features/purchases` returns nothing. |
| Ratchet tests | Confirmed. `document-workspace-canonical.test.ts`, 7 tests, passing. |
| `tsgo --noEmit` clean | Confirmed. |

No inflated claims. One caveat the log understates: 18 of the migrated Sales and
Purchases form files still carry `@ts-nocheck`, so the clean typecheck does not
actually cover the code that was rewritten. That is real debt, not a formality.

## Phase 2 — What the previous plan missed

Two gaps found while auditing, added below:

1. **Inventory peek sheets are a second peek implementation.**
   `AdjustmentPeekSheet.tsx`, `StockTransferPeekSheet.tsx` and
   `WarehouseStockPeekSheet.tsx` hand-roll a drawer; the header comment in the
   adjustment sheet even says it exists "so callers do not" use `PeekScaffold`.
   That is exactly the parallel renderer the parent prompt forbids.
2. **The ratchet only guards Sales and Purchases.** Nothing stops Finance or
   Inventory from adding the next bespoke line editor.

## Remaining work

### Phase 9 — Extend the layer to Finance and Inventory

1. **Journal entries** — `JournalEntryForm.tsx` renders debit/credit lines in a raw
   `<Table>`. Migrate to `EditableLineItemsGrid` with a new `JournalLineRow`
   (account / description / analytic / debit / credit) and a sticky footer showing
   the running debit-credit balance, which the current form lacks visually.
2. **Payment and credit allocation** — `ApplyCreditWizardPage`,
   `ReconcileTransactionSheet`: allocation tables move onto the same grid so the
   allocated-vs-remaining footer behaves like every other document total.
3. **Inventory peek sheets** — rebuild `AdjustmentPeekSheet`,
   `StockTransferPeekSheet` and `WarehouseStockPeekSheet` as `DocumentRecordView`
   descriptors projected through `PeekScaffold`, then delete the bespoke shells.
4. **Warehouse return lines** — `ReturnLinesPanel` onto `SalesReturnLineRow`
   or the read-only grid, whichever matches its editability.

Reuse first: a new row component only when the column contract is genuinely
distinct. Journal lines qualify; allocations likely reuse `PricedLineRow`.

### Phase 10 — Hardening

- Extend `document-workspace-canonical.test.ts` so a bespoke `grid-cols-12` or
  `<Table>` line editor anywhere under `src/features` fails CI, not just Sales
  and Purchases; and so a hand-rolled `<Sheet>` document peek fails too.
- Remove `@ts-nocheck` from the 18 migrated Sales/Purchases form files, fixing
  the errors it hides. This is the step that makes the clean typecheck mean
  something.
- Row memo audit: confirm handlers passed into every row are `useCallback`-stable.
- Narrow-container regression test for the measurement engine.

## Verification at the end

- `tsgo --noEmit` clean *with* the suppressions removed.
- Full ratchet + memo suites pass.
- Playwright pass over the journal entry form, one allocation surface and one
  inventory peek at drawer width and desktop width, screenshotting the line area
  to confirm columns demote rather than scroll horizontally.
- Confirm no orphaned peek shells or line-editor components remain.

## Technical notes

Shared API stays `EditableLineItemsGrid` (`columns`, `rows`, `renderRow(row, i,
layout)`, `onAddRow`, `onRemoveRow`, `footer`, `toolbar`), sharing
`adaptiveColumns.ts` with the read-only grid. No new dependencies.

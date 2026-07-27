# Document / Print / Hardware Reconstruction — Resume Plan

## Phase 1 — Verification of prior work

Spot-checked the state described in `.lovable/plan.md` against the tree:

- Snapshot builders present: `posReceipt`, `posKitchenTicket`, `salesInvoice`, `salesCreditNote`, `salesEstimate`, `salesProforma`, `salesDeliveryNote` — matches "6 of 32 call sites migrated".
- Legacy `usePrintOrPreview` still imported by exactly the pages the plan lists as pending (Sales: `SalesOrders`, `SalesReturns`, `CustomerPayments`, `CustomerStatements`, `CreditNotes` preview leg; Purchases: `Bills`, `PurchaseOrders`, `PurchaseReturns`, `VendorStatements` + peek/record, GRN wizard; HR: `Recruitment`, `ContractsListPage`, `LifecycleTimelinePage`; POS: `POSReports`).
- Gate 0 / 0b (missing `document_kinds`, `resolve_output_intent` scenario fallback) genuinely landed.

Conclusion: the prior plan's status snapshot is accurate. I will not restart; I will resume at the named NEXT item.

## Phase 2 — Corrections / additions to the prior plan

No new architectural gaps found beyond what the prior file already flagged. Two clarifications I will hold myself to:

- A page counts as migrated only when BOTH the print path and the preview path leave `usePrintOrPreview` — same rule the prior audit applied to `CreditNotes`.
- Each destructive removal in Wave 7.3 / Wave 9 must be gated on a green documents+printing suite AND zero remaining importers found by ripgrep, in the same change.

## Phase 3 — Execution order (resuming, unchanged from prior file)

1. **Sales cluster (active).** In order, each landed as one unit (snapshot builder + unit tests + `snapshot-contract` entry + call-site rewrite covering print and preview + eslint allowlist trim when a glob empties):
   1. `SalesOrders` → `sales.order_ack` **(DONE & VERIFIED — 2026-07-27)**
   2. `SalesReturns` → `sales.return` **(DONE & VERIFIED — 2026-07-27)**
   3. `CustomerPayments` → `sales.payment_receipt` **(DONE & VERIFIED — 2026-07-27)**
   4. `CustomerStatements` → `sales.statement` **(DONE & VERIFIED — 2026-07-27)**
   5. Close `CreditNotes` preview leg onto the artifact store. **(NEXT)**
2. **Purchases cluster.** `Bills`, `PurchaseOrders`, `PurchaseReturns`, `VendorStatements` + `VendorStatementPeekSheet` + `VendorStatementRecordPage`, `GoodsReceiptWizardPage`; then remove `src/pages/**` and `src/features/purchases/**` from the eslint allowlist.
3. **HR cluster.** `Recruitment`, `ContractsListPage`, `LifecycleTimelinePage`, `LegalRecipients`.
4. **Inventory labels.** `Products.tsx`, `useLabelPrint.ts` — enforce ADR-0088 (mm-relative geometry) and ADR-0089 (never emit a UUID as barcode; refuse on null resolution).
5. **POS terminal.** `PostPaymentSurface`, `HistoryWorkspace`, `POSReports`, `usePOSCashDrawer` (requires porting the drawer-slip ESC/POS renderer into the Wave 3 engine — fork (2) is still open), `usePrinterStatus`. Guarded by thermal + kitchen goldens.
6. **Cross-cutting.** `useDeviceForIntent`, `BusinessSagaMount`, `PrintPreviewDialog`, `reprintClient` (folded into `submitDocumentIntent({ triggeredSource: 'reprint' })` only after an audit-parity proof that `hardware_command_log.is_reprint = true` end-to-end), `HardwareDevices`.
7. **Wave 7.3 — destructive removal.** Delete `PrintClient.ts`, `usePrintOrPreview.ts`, `reprintClient.ts`, `BrowserHardwareAdapter.print`, and now-dead eslint rules.
8. **Waves 7.5 / 8 / 9.** Architecture guards, transport-router consolidation, destructive legacy removal, then write `docs/architecture/DOCUMENT_PRINT_HARDWARE.md`.

## Invariants (enforced on every step)

- Only `submit-document-intent` writes `print_jobs`; only `dispatch-print-jobs` claims them.
- Hardware access only through `hardwareClient`.
- Every new public table ships GRANT + RLS in the same migration.
- Snapshot builder contract: pure `buildXSnapshot(row)` + `fetchAndBuildXSnapshot(supabase, id)` → `{ document_number, document_date, snapshot }`, with a `SUITE` entry in `snapshot-contract.test.ts`.
- Call-site pattern: build snapshot → `ensureDocumentRecord({ kindCode, … })` → `submitDocumentIntent({ documentRecordId, scenario })`.
- Verification bar per step: clean `tsgo` on touched files + green `src/test/documents` and `src/test/printing`. Pre-existing ~118-failure baseline outside those suites is not in scope.

## Immediate next action once approved

Close the `CreditNotes` preview leg: the print path already uses the intent engine, but the preview button still calls `usePrintOrPreview`. Route the preview through `fetchAndBuildCreditNoteSnapshot → ensureDocumentRecord({ kindCode: 'sales.credit_note' }) → submitDocumentIntent({ triggeredSource: 'manual' })` so no leg bypasses the routing plan. Once done, drop `CreditNotes.tsx` from the eslint allowlist for `usePrintOrPreview` if the glob empties.

### CustomerStatements landing note (2026-07-27)

- Added `src/services/documents/snapshots/salesCustomerStatement.ts` mirroring `generate-document::fetchCustomerStatement`. Pure `buildCustomerStatementSnapshot` computes the sorted ledger + running balance (opening → invoices/payments/CNs) and the 5-bucket aging summary (Current / 1-30 / 31-60 / 61-90 / 90+) from unpaid invoice remainders only. `fetchAndBuildCustomerStatementSnapshot` reproduces the edge function's three period-scoped queries (invoices, payments, credit_notes with status in `issued|applied|partially_applied`), scoped by `business_id` when present. Injectable `now` keeps aging deterministic.
- Added `src/test/documents/sales-customer-statement-snapshot.test.ts` (9 cases: doc-type/label/number, stable sort + running balance, closing_balance fallback + honor, aging math, sent-vs-draft status, currency resolution, determinism, identity guards) and a `snapshot-contract` SUITE entry (now 12 builders under contract).
- `CustomerStatements.tsx`: removed `usePrintOrPreview` / `downloadPdf`. The single "Download PDF" leg now dispatches through `ensureDocumentRecord({ kindCode: 'sales.statement' }) → submitDocumentIntent({ triggeredSource: 'manual' })`, so the routing plan (`view|download|email`) is the sole exit — CSV export is unchanged (still `printClient.downloadExport`, which itself archives to version history).
- Verification: `src/test/documents` — 90/90 green (12 files); `tsgo` clean on touched files (`CustomerStatements.tsx`, `salesCustomerStatement.ts`, `snapshot-contract.test.ts`).

### Instructions for the next agent

1. **Verify before continuing.** Re-run `bunx vitest run src/test/documents` (expect 90+ green) and `grep -R "usePrintOrPreview\|downloadPdf" src/pages/CustomerStatements.tsx src/pages/CustomerPayments.tsx src/pages/SalesOrders.tsx src/pages/SalesReturns.tsx` (expect empty). Confirm `sales.statement` still exists in `document_kinds` and that the snapshot's `statement_transactions` / `statement_aging` field shapes match the renderer (`src/services/documents/templates/**`). If any check fails, fix the regression before starting new work — do not paper over it.
2. **Resume at Sales step 5**, not somewhere else in the roadmap: close the `CreditNotes` preview leg. Only move to the Purchases cluster once every Sales page's print, preview, download, and email legs go through `submitDocumentIntent`.
3. Keep the plan (`.lovable/plan.md`) as the single source of truth — every landing gets a dated note here, not just in commit messages.

### CustomerPayments landing note (2026-07-27)

- Added `src/services/documents/snapshots/salesPaymentReceipt.ts` mirroring `generate-document::fetchReceipt` — items-as-truth from `payment_allocations`, uniform-or-fallback currency, unapplied advance suppressed when restricted to a single invoice.
- Added `src/test/documents/sales-payment-receipt-snapshot.test.ts` (10 cases: label, RCP fallback, sort order, items-as-truth totals, restrict-to-invoice suppression, on-account fallback, currency resolution, method label mapping, determinism, identity guards) and a `snapshot-contract` SUITE entry.
- `CustomerPayments.tsx`: removed `usePrintOrPreview`, removed `PrintPreviewDialog`, collapsed `handleViewReceipt` / `handleDownloadReceipt` / `onPrintReceipt` into one `handleDispatchReceipt` that runs `fetchAndBuildPaymentReceiptSnapshot → ensureDocumentRecord({ kindCode: 'sales.payment_receipt' }) → submitDocumentIntent({ triggeredSource: 'manual' })`. All three legs now share the routing plan — a preview cannot bypass fiscal/archive dispositions.
- Verification: `src/test/documents` — 80/80 green; `tsgo` clean on touched files.

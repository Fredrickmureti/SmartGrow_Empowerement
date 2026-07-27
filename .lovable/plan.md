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
   1. `SalesOrders` → `sales.order_ack` **(NEXT)**
   2. `SalesReturns` → `sales.return`
   3. `CustomerPayments` → `sales.payment_receipt`
   4. `CustomerStatements` → `sales.statement`
   5. Close `CreditNotes` preview leg onto the artifact store.
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

Land `SalesOrders` → `sales.order_ack` as one complete unit (builder + tests + contract entry + print/preview rewrite), update `.lovable/plan.md` to mark it DONE & VERIFIED, then proceed to `SalesReturns`.

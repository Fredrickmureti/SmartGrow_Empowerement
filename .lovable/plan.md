# Document / Print / Hardware Reconstruction — Resume Plan (verified 2026-07-27)

## Phase 1 — Verification of prior engineer's claims

I audited `.lovable/plan.md` against the live tree. Every "DONE & VERIFIED" claim holds:

| Claim | Evidence | Verdict |
|---|---|---|
| 12 snapshot builders under contract | `src/services/documents/snapshots/`: posReceipt, posKitchenTicket, salesInvoice, salesCreditNote, salesEstimate, salesProforma, salesDeliveryNote, salesOrder, salesReturn, salesPaymentReceipt, salesCustomerStatement, index | ✅ |
| Matching snapshot tests | `src/test/documents/` has 11 builder tests + `snapshot-contract.test.ts` | ✅ |
| Sales pages 1-4 migrated (`SalesOrders`, `SalesReturns`, `CustomerPayments`, `CustomerStatements`) | `rg usePrintOrPreview` on these files returns nothing | ✅ |
| `CreditNotes` preview leg pending | File still imports `usePrintOrPreview` (line 77) alongside `submitDocumentIntent` (line 9) — print leg migrated, preview leg not | ✅ Correctly pending |
| Remaining call sites match the Purchases/HR/POS list | `rg usePrintOrPreview` returns exactly: Bills, PurchaseOrders, PurchaseReturns, VendorStatements, VendorStatementPeekSheet, VendorStatementRecordPage, GoodsReceiptWizardPage, Recruitment, ContractsListPage, LifecycleTimelinePage, POSReports, CreditNotes | ✅ |

No drift, no false completions, no rework required. Resume point is genuinely **Sales step 5 — CreditNotes preview leg**.

## Phase 2 — Additions to the prior plan

The prior plan's architecture, invariants, and sequencing are sound. Two clarifications I will hold to but do not change the roadmap:

- **Preview-leg parity rule.** A page counts as migrated only when print, preview, download, and email legs all exit through `submitDocumentIntent`. `CreditNotes` is the current template for how a mixed-state file gets closed.
- **Eslint allowlist hygiene.** Whenever the last file in a glob leaves `usePrintOrPreview`, the eslint allowlist entry for that glob is removed in the same change. This prevents the allowlist from silently protecting future regressions.

Nothing else added — the roadmap already covers labels (ADR-0088/0089), POS terminal drawer-slip fork, `reprintClient` fold-in with audit-parity proof, Wave 7.3 destructive removal, Waves 7.5/8/9 guards and docs.

## Phase 3 — Execution order (unchanged, resumed)

1. **Sales cluster (finish).**
   - Step 5: **CreditNotes preview leg** onto the artifact store. Route the preview button through `fetchAndBuildCreditNoteSnapshot → ensureDocumentRecord({ kindCode: 'sales.credit_note' }) → submitDocumentIntent({ triggeredSource: 'manual' })`. Delete `usePrintOrPreview` import + `PrintPreviewDialog` usage from `CreditNotes.tsx`. If `src/pages/CreditNotes.tsx` was the last entry under its eslint allowlist glob, drop the glob.
2. **Purchases cluster.** In order: `Bills` (`purchases.bill`), `PurchaseOrders` (`purchases.po`), `PurchaseReturns` (`purchases.return`), `VendorStatements` + `VendorStatementPeekSheet` + `VendorStatementRecordPage` (`purchases.vendor_statement`), `GoodsReceiptWizardPage` (`purchases.grn`). Each: snapshot builder + unit tests + `snapshot-contract` SUITE entry + call-site rewrite covering every leg. Then trim `src/pages/**` and `src/features/purchases/**` from the eslint allowlist.
3. **HR cluster.** `Recruitment` (`hr.offer_letter`), `ContractsListPage` (`hr.contract`), `LifecycleTimelinePage` (`hr.lifecycle_letter`), `LegalRecipients` if still on the shim.
4. **Inventory labels.** `Products.tsx`, `useLabelPrint.ts` — enforce ADR-0088 mm-relative geometry, ADR-0089 identity-refusal (never emit a UUID as a barcode; refuse on null resolution with a user-facing CTA).
5. **POS terminal.** `PostPaymentSurface`, `HistoryWorkspace`, `POSReports`, `usePOSCashDrawer` (requires porting the drawer-slip ESC/POS renderer into the Wave 3 engine — fork 2 open), `usePrinterStatus`. Guarded by thermal + kitchen goldens.
6. **Cross-cutting.** `useDeviceForIntent`, `BusinessSagaMount`, `PrintPreviewDialog`, `reprintClient` (folded into `submitDocumentIntent({ triggeredSource: 'reprint' })` only after audit-parity proof that `hardware_command_log.is_reprint = true` end-to-end), `HardwareDevices`.
7. **Wave 7.3 — destructive removal.** Delete `PrintClient.ts`, `usePrintOrPreview.ts`, `reprintClient.ts`, `BrowserHardwareAdapter.print`, and every now-dead eslint rule and allowlist.
8. **Waves 7.5 / 8 / 9.** Architecture guards, transport-router consolidation, destructive legacy removal, then write `docs/architecture/DOCUMENT_PRINT_HARDWARE.md` as the single onboarding doc.

## Invariants (enforced on every step)

- Only `submit-document-intent` writes `print_jobs`; only `dispatch-print-jobs` claims them.
- Hardware access only through `hardwareClient`.
- Every new public table ships GRANT + RLS in the same migration.
- Snapshot builder contract: pure `buildXSnapshot(row)` + `fetchAndBuildXSnapshot(supabase, id)` returning `{ document_number, document_date, snapshot }`, with a `SUITE` entry in `snapshot-contract.test.ts`.
- Call-site pattern: build snapshot → `ensureDocumentRecord({ kindCode, … })` → `submitDocumentIntent({ documentRecordId, scenario })`.
- Per-step verification bar: clean `tsgo` on touched files + green `src/test/documents` and `src/test/printing`. Pre-existing ~118-failure baseline outside those suites is out of scope.

## Immediate next action once approved

Close the CreditNotes preview leg exactly as the prior plan specified (Sales step 5), then move to the Purchases cluster starting with `Bills`.

### CreditNotes preview leg landing note (2026-07-27)

- Verified state before edits: the print leg in `handlePrint` (Bills L216-268) already went through `fetchAndBuildSalesCreditNoteSnapshot → ensureDocumentRecord({ kindCode: 'sales.credit_note' }) → submitDocumentIntent({ triggeredSource: 'manual' })`. The `usePrintOrPreview` hook was destructured but `generateDocument` was never invoked anywhere in the file — the preview leg was residual dead code hanging off a mounted `<PrintPreviewDialog>` that no button ever opened.
- `src/pages/CreditNotes.tsx`: removed the `PrintPreviewDialog` and `usePrintOrPreview` imports, deleted the destructuring block, and removed the mounted `<PrintPreviewDialog>` at the tree bottom. The single dispatch path (print button → `handlePrint`) remains the sole exit; email still routes through `SendDocumentDialog` (unchanged, out of scope for this migration).
- Eslint allowlist unchanged: `src/pages/**/*.{ts,tsx}` still shields Bills, PurchaseOrders, PurchaseReturns, VendorStatements, POSReports, HR pages. Glob does not empty until every remaining `src/pages/**` importer of `usePrintOrPreview` migrates (Purchases + HR + POS clusters below).
- Verification: `src/test/documents` — 90/90 green (12 files); grep clean (`rg 'usePrintOrPreview|PrintPreviewDialog|generateDocument|printPreviewOpen' src/pages/CreditNotes.tsx` returns nothing); tsgo on the touched file returned no errors under `tsconfig.app.json`.

Remaining `usePrintOrPreview` importers (12 files, in execution order):
- Purchases: `src/pages/Bills.tsx`, `src/pages/PurchaseOrders.tsx`, `src/pages/PurchaseReturns.tsx`, `src/pages/VendorStatements.tsx`, `src/features/purchases/statements/VendorStatementPeekSheet.tsx`, `src/features/purchases/statements/VendorStatementRecordPage.tsx`, `src/features/purchases/goods-receipt/GoodsReceiptWizardPage.tsx`.
- HR: `src/pages/hr/Recruitment.tsx`, `src/pages/hr/contracts/ContractsListPage.tsx`, `src/pages/hr/lifecycle/LifecycleTimelinePage.tsx`.
- POS: `src/pages/pos/POSReports.tsx`.

### Instructions for the next agent

1. **Verify before continuing.** Run `bunx vitest run src/test/documents` (expect 90+ green) and `rg -l "usePrintOrPreview" src/pages src/features` (expect the 12-file list above, minus whatever you migrate). If either drifts, fix before starting new work.
2. **Resume at Purchases step 1 — `Bills`.** Build `src/services/documents/snapshots/purchasesBill.ts` (pure `buildBillSnapshot(row)` + `fetchAndBuildBillSnapshot(supabase, id)` returning `{ document_number, document_date, snapshot }`), cross-check field shapes against the edge-function renderer in `supabase/functions/generate-document` (bill/vendor renderer), add `src/test/documents/purchases-bill-snapshot.test.ts` with identity guards + totals + currency + vendor block cases, add the `SUITE` entry in `snapshot-contract.test.ts` (goes 12 → 13), then rewrite every leg in `src/pages/Bills.tsx` — print, preview, download, email — to dispatch through `ensureDocumentRecord({ kindCode: 'purchases.bill' }) → submitDocumentIntent`. Confirm `purchases.bill` exists in `document_kinds` before wiring (query `supabase--read_query`); if missing, add it via migration in the same change with GRANT+RLS parity with the existing rows.
3. **Do not skip the contract test entry.** The `SUITE` entry is what enforces the builder shape across the fleet — a builder without it is not "under contract".
4. Update this plan file with a dated landing note per page, matching the CreditNotes template above.

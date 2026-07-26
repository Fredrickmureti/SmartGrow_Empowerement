# AccrualFlow Print Pipeline — Implementation Roadmap

Living document. Updated after each phase completes.

## Status snapshot

| Phase | Scope | State |
| --- | --- | --- |
| **Investigation** | Two-pipeline audit, root cause | ✅ Done (report preserved in git history) |
| **P1** | FIFO queue + non-blocking button in the A4/PDF branch; Invoices canary | ✅ Done, verified |
| **P2 Step 1** | Ledger-cover interactive prints fired from `PrintPreviewDialog` | ✅ Done, verified |
| **P2 Step 2** | Retire remaining `useDocumentPrint` direct consumers (Statements, POS, Vendor peek/record) | ⏳ Next |
| **P2 Step 3** | Delete `useDocumentPrint`; shrink ESLint allowlist to empty | ⏳ Pending Step 2 |
| **P3** | Unify job identity (correlation-id → idempotency-key) across raw-bytes + PDF; Platform → Print Queue admin view | ⏳ Pending P2 |

## Root cause (original finding — kept for context)

Two pipelines, materially different concurrency guarantees:

- **Labels / raw-bytes** — client mutex in `AgentClient._withEndpointLock` + server FIFO in `agent/src/routes/print.ts`. Rapid clicks survive.
- **A4 / PDF** — hidden `<iframe>` + `window.print()`; button disabled while `isPrinting`, so React dropped clicks 2..N at the DOM. No queue existed on this path.

## What is shipped and verified

### P1 — FIFO queue on the PDF branch (`ADR-0026 · Wave B3 · Plan P1`)
- `src/services/printing/pdfUtils.ts` — module-scoped `pdfPrintQueue` promise chain wraps every `printPdfInPage(blob)` call. Overlapping browser print dialogs are structurally impossible. A failed job doesn't poison the chain. `__printPdfInPageQueueDrained()` exported for tests.
- `src/components/common/PrintPreviewDialog.tsx` — Print button no longer `disabled` while a job is in flight. `pendingPrints` counter increments per click; label reads `Print (N queued)` when the backlog is > 1. Rapid clicks enqueue instead of vanishing.
- `src/test/printing/print-pdf-fifo-queue.test.ts` — locks the invariant: 5 concurrent calls → 5 sequential iframes/dialogs, none coalesced, none dropped; failing job doesn't block the next.
- **Blast radius** — all 11 sales/purchase pages (Invoices, Bills, CreditNotes, DeliveryNotes, Estimates, ProformaInvoices, PurchaseOrders, PurchaseReturns, SalesOrders, SalesReturns, CustomerPayments) already route through `usePrintOrPreview` and fall back to `PrintPreviewDialog` for `ask_user`, so all inherit the fix without per-page changes.

### P2 Step 1 — Interactive-print ledger coverage (`ADR-0026 · Wave B3 · Plan P2 Step 1`)
- `src/services/printing/PrintClient.ts` — new public `recordInteractivePrint({documentType, documentId, intent, format, businessId, branchId, printerProfileId?}) → {jobId, markSent, markFailed}`. Reuses the same `insertLedgerRow / markLedgerSent / markLedgerFailed` helpers as the auto_print path, so both branches now write the same rows to `print_jobs` under the same 2-second `correlation_id` bucket. Returns a no-op handle (never throws) when `businessId` is null or the RPC fails.
- `src/components/common/PrintPreviewDialog.tsx` — `handlePrint` now bookends the thermal (`printRawBytes`) and PDF (`printPdfInPage`) branches with `recordInteractivePrint → markSent/markFailed`. Dialog pulls `currentBusiness` via `useBusinesses` and `currentBranch` via existing `useBranch`.
- `src/test/printing/interactive-print-ledger.test.ts` — locks: insert-then-mark contract, no-op when `businessId` is null, never throws when the RPC errors.
- **Net effect** — every A4/PDF and interactive-thermal print now appears in `print_jobs`, closing the audit hole for the `ask_user` policy branch and every legacy shadow-path surface. Auto-print rows and interactive rows share the same schema and correlation-id bucketing, so a rapid double-click that crosses branches still collapses on `(business_id, correlation_id)` uniqueness in the RPC.

## Active phase

**P2 Step 1 — Complete.** No open follow-ups on this step.

## Next up — P2 Step 2

Retire the last direct callers of `useDocumentPrint` that are NOT the 11 sales/purchase pages (those already flow through `usePrintOrPreview`). Current allowlist residents to migrate:

- `src/pages/CustomerStatements.tsx`
- `src/pages/VendorStatements.tsx`
- `src/features/purchases/statements/VendorStatementPeekSheet.tsx`
- `src/features/purchases/statements/VendorStatementRecordPage.tsx`
- `src/pages/pos/POSReports.tsx`
- `src/pages/pos/POSSettings.tsx`
- `src/pages/pos/POSTerminal.tsx` (verify — receipt printing already uses `PrintClient.print({intent:'receipt'})`; only the preview fallback should remain)
- `src/components/pos/TransactionHistoryDialog.tsx`

**Migration recipe (mirror the 11 sales/purchase pages):**
1. Swap `useDocumentPrint()` → `usePrintOrPreview()` (identical field surface — `generateDocument`, `downloadPdf`, `printPreviewOpen`, `setPrintPreviewOpen`, `printPreviewTitle`, `printDocumentType`, `printDocumentId`, `printCommunication`, `isGeneratingPdf`).
2. Rename any local `generateDocument(...)` invocations left untouched — the signature is identical, so most files are a two-line diff.
3. Remove the file from `eslint-rules/no-document-print-shadow-path.js` allowlist.
4. Run `bunx vitest run src/test/printing` and `bunx tsgo --noEmit -p tsconfig.app.json` after each file.

**Do not touch** `src/hooks/useDocumentPrint.ts`, `src/hooks/useDocumentPrintPolicies.ts`, `src/hooks/usePrinterProfiles.ts`, `src/hooks/usePrintOrPreview.ts`, `src/components/settings/PrinterProfilesCard.tsx`, `src/components/settings/PrintingSettings.tsx` — these are legitimate infrastructure allowlist entries, not shadow-path consumers.

## Then — P2 Step 3

After Step 2 leaves only infrastructure entries in the allowlist:
- Delete `useDocumentPrint` (fold `downloadPdf` into `PrintClient.download()`).
- Remove `usePrintOrPreview`'s fallback branch — no need once no page can reach the shadow path.
- Reduce `no-document-print-shadow-path.js` allowlist to `usePrintOrPreview.ts` only (or delete the rule).

## Then — P3

- Promote `correlation_id` to a true idempotency key (per-click UUID) rather than a 2-second bucket, propagated from every UI submit through `PrintClient.print` and `recordInteractivePrint`.
- Chain raw-bytes and PDF ledger rows via `parent_job_id` when a policy fans out copies across transports.
- Ship a Platform → Print Queue admin view backed by the existing `print_jobs` table + status machine (`queued → sent → acked | failed`).

## Instructions for the next agent

1. **Verify P2 Step 1 before continuing.** Read `src/services/printing/PrintClient.ts` lines ~510-570 and `src/components/common/PrintPreviewDialog.tsx` lines ~327-425. Confirm:
   - `recordInteractivePrint` returns a no-op handle when `businessId` is null and never throws on RPC failure.
   - Both thermal and PDF branches in `handlePrint` bookend the transport call with `ledger.markSent()` / `ledger.markFailed(err.message)`.
   - Tests pass: `bunx vitest run src/test/printing/interactive-print-ledger.test.ts src/test/printing/print-pdf-fifo-queue.test.ts`.
   - No new items appear in `bunx tsgo --noEmit -p tsconfig.app.json` for the touched files.
2. **Only then** begin P2 Step 2 (list above). Migrate ONE file at a time, run the same two verification commands after each file, and update this plan's Status snapshot as each file lands.
3. **Do not** open P3 work while any P2 Step 2 file remains on the allowlist. Do not add debounce/throttle/setTimeout to any print path — the queue is the answer, not click-guards.
4. **Do not** modify `pdfUtils.ts`'s queue, `PrintClient.recordInteractivePrint`, or `PrintPreviewDialog.handlePrint` while doing Step 2 — those are the load-bearing invariants for both auto-print and interactive-print correctness and are covered by tests.

## Pre-existing, unrelated
- `src/test/printing/print-client-policy.test.ts > caches resolved policies …` fails counting all `supabase.rpc` calls but did not account for `print_job_insert` added in ADR-0090. Not caused by P1/P2 work. Fix while doing P2 Step 2 if it aids the migration; otherwise leave for its own micro-plan.

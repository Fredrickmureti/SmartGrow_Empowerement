# Print Pipeline — Verification & Continuation Plan

## Verification of prior work (evidence read from the current codebase)

Prior engineer's `.lovable/plan.md` claims P1 and P2 Step 1 done, P2 Step 2 / Step 3 / P3 pending. Independent audit:

**P1 — FIFO queue on the PDF branch — CONFIRMED.**
- `src/services/printing/pdfUtils.ts` holds a module-scoped `pdfPrintQueue` promise chain (lines 58–68) and exports `__printPdfInPageQueueDrained()` at line 144 for tests.
- `src/test/printing/print-pdf-fifo-queue.test.ts` exists.
- `PrintPreviewDialog` Print button is not disabled during in-flight jobs; enqueues on rapid clicks.

**P2 Step 1 — Interactive-print ledger — CONFIRMED.**
- `PrintClient.recordInteractivePrint(...)` at `src/services/printing/PrintClient.ts:536`.
- `PrintPreviewDialog.tsx` bookends both the thermal (`printRawBytes`) and PDF (`printPdfInPage`) branches with `recordInteractivePrint → markSent/markFailed` (calls at lines 365 and 407).
- `src/test/printing/interactive-print-ledger.test.ts` exists.

**Root-cause finding — CONFIRMED as originally stated.** Two pipelines existed: raw-bytes (labels) had a client mutex (`AgentClient._withEndpointLock`) + server FIFO (`agent/src/routes/print.ts`), so rapid clicks survived. The A4/PDF path disabled its button during `isPrinting`, causing React to swallow clicks 2..N at the DOM. P1 removed the disable and added the queue. Behaviour now converges across labels and documents.

**P2 Step 2 allowlist — DRIFTED from plan.**
- Sales/purchase pages listed on the shadow-path ESLint allowlist (`Bills`, `CreditNotes`, `CustomerPayments`, `DeliveryNotes`, `Estimates`, `Invoices`, `ProformaInvoices`, `PurchaseOrders`, `PurchaseReturns`, `SalesOrders`, `SalesReturns`) already import `usePrintOrPreview` only — they're on the allowlist solely because `usePrintOrPreview` internally falls back to `useDocumentPrint`. They should not be treated as Step-2 migration targets.
- `src/pages/pos/POSTerminal.tsx` and `src/components/pos/TransactionHistoryDialog.tsx` do NOT import `useDocumentPrint` (file for TransactionHistoryDialog doesn't exist) — stale allowlist entries to remove.
- `src/pages/pos/POSReports.tsx` already uses `usePrintOrPreview` (already migrated; drop from allowlist).
- `src/pages/pos/POSSettings.tsx` only imports `useResolvedPrintPolicyWithDevice` from `useDocumentPrintPolicies` (a legitimate infra hook), not `useDocumentPrint` — the ESLint rule likely matches the module prefix; scope the rule or drop this file from the allowlist.
- **Real Step-2 targets (direct `useDocumentPrint` consumers):** `src/pages/CustomerStatements.tsx`, `src/pages/VendorStatements.tsx`, `src/features/purchases/statements/VendorStatementPeekSheet.tsx`, `src/features/purchases/statements/VendorStatementRecordPage.tsx`.

**Pre-existing failing test.** `src/test/printing/print-client-policy.test.ts > caches resolved policies` counts all `supabase.rpc` calls and doesn't account for the `print_job_insert` RPC added in ADR-0090. Unrelated to prior phases; fold into Step 2.

## Continuation plan

### Step A — Reconcile the allowlist (small, safe, unblocks measurement)

1. In `eslint-rules/no-document-print-shadow-path.js`:
   - Remove entries whose files no longer exist or no longer import `useDocumentPrint`: `POSTerminal.tsx`, `TransactionHistoryDialog.tsx`, `POSReports.tsx`, `POSSettings.tsx`.
   - Tighten the matcher so imports of `useDocumentPrintPolicies` / `usePrinterProfiles` are not flagged as `useDocumentPrint` (specific specifier + module suffix match), then remove `POSSettings.tsx`.
2. Run ESLint to confirm no new violations.

### Step B — Finish P2 Step 2 (migrate the four remaining direct consumers)

For each file below, one at a time:
- Replace `useDocumentPrint()` with `usePrintOrPreview()` (identical `downloadPdf` / `isGeneratingPdf` surface).
- Remove the file from the allowlist.
- Verify: `bunx vitest run src/test/printing` + `bunx tsgo --noEmit -p tsconfig.app.json`.

Order:
1. `src/pages/CustomerStatements.tsx`
2. `src/pages/VendorStatements.tsx`
3. `src/features/purchases/statements/VendorStatementPeekSheet.tsx`
4. `src/features/purchases/statements/VendorStatementRecordPage.tsx`

Also: fix `print-client-policy.test.ts` expected RPC count to include `print_job_insert`.

### Step C — P2 Step 3 (collapse the shadow path)

After Step B leaves only infra entries on the allowlist:
- Fold `downloadPdf` into `PrintClient.download()` (single owner).
- Delete `usePrintOrPreview`'s `useDocumentPrint` fallback branch — the queue in `pdfUtils` and the interactive ledger already cover ask_user and failure paths.
- Delete `src/hooks/useDocumentPrint.ts`.
- Shrink `no-document-print-shadow-path.js` allowlist to infra-only (or delete the rule).
- Verify build + full `src/test/printing` suite.

### Step D — P3 (unified job identity + admin visibility)

1. **Per-click idempotency key.** Replace the 2-second `correlation_id` bucket with a UUID minted at the UI submit boundary (button handler or `usePrintOrPreview.generateDocument`). Propagate through `PrintClient.print`, `recordInteractivePrint`, the `print_job_insert` RPC, and the agent request headers so raw-bytes and PDF share one identity model. Add DB uniqueness on `(business_id, idempotency_key)`.
2. **Parent/child chaining.** When a policy fans a document out to multiple transports (thermal receipt + A4 archive), chain rows via `parent_job_id` on `print_jobs`.
3. **Admin surface.** Ship `Platform → Print Queue` view backed by `print_jobs` with the `queued → sent → acked | failed` status machine; filter by business, branch, document type, correlation, and job state. Read-only in this phase.
4. **Ledger completion signal.** Wire the agent's job-complete callback to write `acked_at` so the admin view distinguishes "sent to agent" from "printed". No new transports.

### Step E — Guardrails so the two-pipeline drift cannot return

- Architecture test: assert no file outside `src/services/printing/**` and `src/hooks/usePrintOrPreview.ts` imports `useDocumentPrint` (once Step C deletes it, convert to a no-import assertion).
- Architecture test: assert no page-level component calls `window.print()` or mounts a print `<iframe>` outside `pdfUtils`.
- Architecture test: assert every UI print entry point goes through `PrintClient.print` OR `usePrintOrPreview.generateDocument`.
- Extend `src/test/printing/print-pdf-fifo-queue.test.ts` with a parity test that runs the same 5-concurrent-clicks assertion against the raw-bytes path via a mocked `AgentClient`, so both pipelines are locked to identical FIFO semantics.

### Non-goals (explicit)

- No debounce, throttle, `setTimeout`, retry-until-it-works, or permanent button-disable on any print path.
- No new transport, no new edge-agent endpoint, no changes to `agent/src/routes/print.ts` queue semantics.
- No changes to statutory-paper-pinned generators (see ADR-0008).

## Technical notes

- Load-bearing invariants — do not modify while executing Steps A–B: `pdfUtils.pdfPrintQueue`, `PrintClient.recordInteractivePrint`, `PrintPreviewDialog.handlePrint`, `AgentClient._withEndpointLock`, `agent/src/routes/print.ts` FIFO.
- After Step D the canonical lifecycle becomes:
  ```text
  UI submit
    → idempotency-key mint
    → PrintClient.print (single owner)
      → policy resolve (paper/transport)
      → ledger insert (queued)
      → transport (pdfPrintQueue | AgentClient endpoint-lock)
      → ledger markSent
      → agent ack → ledger acked
  ```
- ESLint allowlist reconciliation in Step A is prerequisite because the current list conflates "imports `useDocumentPrint`" with "imports anything from a module starting with `useDocumentPrint`", producing false positives that make Step-C's "list is empty" exit criterion unmeasurable.

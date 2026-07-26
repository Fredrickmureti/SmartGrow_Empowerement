# AccrualFlow Print Pipeline — Implementation Roadmap

Living document. Updated after each phase completes.

## Status snapshot

| Phase | Scope | State |
| --- | --- | --- |
| **Investigation** | Two-pipeline audit, root cause | ✅ Done |
| **P1** | FIFO queue + non-blocking button in the A4/PDF branch | ✅ Done, verified |
| **P2 Step 1** | Interactive-print ledger via `recordInteractivePrint` | ✅ Done, verified |
| **P2 Step 2** | Retire remaining `useDocumentPrint` direct consumers + reconcile allowlist | ✅ Done (2026-07-26) |
| **P2 Step 3** | Fold `downloadPdf` into `PrintClient`, delete `useDocumentPrint` | ⏳ Pending |
| **P3 Step 1** | Per-click idempotency key at UI submit boundaries | ✅ Done (2026-07-26) |
| **P3 Step 2** | Parent/child chaining on `print_jobs` (fan-out copies) | ✅ Done (2026-07-26) |
| **P3 Step 3** | Platform → Print Queue admin view | ⏳ Pending |
| **P3 Step 4** | Agent job-complete callback → `acked_at` | ⏳ Pending |
| **Guardrails** | Architecture tests locking single-pipeline invariant | ⏳ Pending |

## Root cause (kept for context)

Two pipelines with materially different concurrency guarantees:
- **Labels / raw-bytes** — client mutex in `AgentClient._withEndpointLock` + server FIFO in `agent/src/routes/print.ts`. Rapid clicks survive.
- **A4 / PDF** — hidden `<iframe>` + `window.print()`; button disabled while `isPrinting`, so React dropped clicks 2..N at the DOM. No queue existed.

P1 replaced the disable with `pdfPrintQueue` (module-scoped promise chain). P2 wired every A4/PDF and interactive-thermal print into the same `print_jobs` ledger the auto-print path already used.

## What is shipped and verified

### P1 — FIFO queue on the PDF branch
- `src/services/printing/pdfUtils.ts` — module-scoped `pdfPrintQueue` (line ~58); `__printPdfInPageQueueDrained()` exported for tests.
- `src/components/common/PrintPreviewDialog.tsx` — Print button no longer disabled during in-flight jobs; label reads `Print (N queued)` when backlog > 1.
- `src/test/printing/print-pdf-fifo-queue.test.ts` — 5 concurrent calls → 5 sequential iframes, none coalesced, failing job doesn't poison chain.

### P2 Step 1 — Interactive-print ledger
- `PrintClient.recordInteractivePrint(...)` returns `{jobId, markSent, markFailed}`; no-op handle when `businessId` is null; never throws.
- `PrintPreviewDialog.handlePrint` bookends thermal (`printRawBytes`) and PDF (`printPdfInPage`) branches.
- `src/test/printing/interactive-print-ledger.test.ts`.

### P2 Step 2 — Direct-consumer migration + allowlist reconcile (2026-07-26)
Migrated from `useDocumentPrint` → `usePrintOrPreview` (drop-in `downloadPdf`/`isGeneratingPdf`):
- `src/pages/CustomerStatements.tsx`
- `src/pages/VendorStatements.tsx`
- `src/features/purchases/statements/VendorStatementPeekSheet.tsx`
- `src/features/purchases/statements/VendorStatementRecordPage.tsx`

Cleaned `eslint-rules/no-document-print-shadow-path.js` allowlist:
- Dropped all 11 sales/purchase pages (they reach `useDocumentPrint` only transitively through `usePrintOrPreview`).
- Dropped stale entries `POSTerminal.tsx`, `POSReports.tsx`, `POSSettings.tsx`, `TransactionHistoryDialog.tsx` (no direct import; TransactionHistoryDialog file no longer exists).
- Added `src/pages/hr/payroll/LegalRecipients.tsx` (uses `printDocument`, not covered by `usePrintOrPreview` surface — out of scope for the print-pipeline audit).

Remaining direct consumers (all infra / non-shadow-path):
```
src/components/common/PrintSettingsPopover.tsx
src/components/finance/CreditNoteDetailDialog.tsx
src/components/settings/PrinterProfilesCard.tsx
src/components/settings/PrintingSettings.tsx
src/hooks/useDocumentPrint.ts
src/hooks/useDocumentPrintPolicies.ts
src/hooks/usePrinterProfiles.ts
src/hooks/usePrintOrPreview.ts             (fallback wrapper)
src/pages/hr/payroll/LegalRecipients.tsx   (uses printDocument)
```

Also fixed `src/test/printing/print-client-policy.test.ts > caches resolved policies` to filter `rpcMock` calls to `print_policies_resolve` only (was counting the ADR-0090 `print_job_insert` RPCs too).

Verification: `bunx vitest run src/test/printing` → 22 files / 146 tests all pass.

## Next up — P2 Step 3 (collapse the shadow path)

Prerequisites: none blocking; `PrintSettingsPopover`, `CreditNoteDetailDialog`, settings pages, and `LegalRecipients` still consume `useDocumentPrint` directly. Two options:

**Option A — Fold `downloadPdf` and `printDocument` into `PrintClient`.**
- Extend `PrintClient` with a `.download(documentType, documentId, filename)` method that mirrors the existing invoke-`generate-document` path currently owned by `useDocumentPrint`, sharing the `print_jobs` ledger insert.
- Add a `.printDocument(...)` companion (only needed by `LegalRecipients`).
- Migrate the four infra callers above onto the new `PrintClient` methods.
- Delete `useDocumentPrint.ts`.
- Simplify `usePrintOrPreview` to no longer wrap `useDocumentPrint`.
- Reduce allowlist to `useDocumentPrintPolicies.ts` / `usePrinterProfiles.ts` / `usePrintOrPreview.ts` (or delete rule if no consumers remain).

**Option B — Ship P3 first, then Step 3.**
Idempotency-key work in P3 changes the ledger schema and `PrintClient` insert path; folding downloads in first, then reworking the identity model, means two passes over the same code. Prefer A only if there is appetite to touch it twice.

Recommendation: proceed to P3 first, then do Step 3 on top of the new identity contract.

## Then — P3 (unified job identity + admin visibility)

1. **Per-click idempotency key. ✅ Shipped 2026-07-26.**
   - `PrintRequest.idempotencyKey` added; `PrintClient.correlationId` prefers it and falls back to the legacy 2s bucket for un-migrated callers.
   - Minted at both UI submit boundaries: `usePrintOrPreview.printOrPreview` and `PrintPreviewDialog.handlePrint` (single UUID shared by thermal + PDF branches within one click).
   - `recordInteractivePrint({ ... idempotencyKey })` threads it into `print_job_insert`.
   - DB already enforces `UNIQUE (public.print_jobs.business_id, correlation_id)` (index `print_jobs_business_id_correlation_id_key`), so the key is fully load-bearing — no schema migration needed.
   - Contract test: `src/test/printing/print-client-idempotency-key.test.ts` (4 tests).
2. **Parent/child chaining. ✅ Shipped 2026-07-26.**
   - `PrintClient.print` now inserts a parent container row up-front, then per-copy child rows with `p_parent_job_id` set. Single-copy jobs keep the legacy single-row shape (no redundant child).
   - Children get suffixed correlation ids `${key}:copy:${i}` so the `(business_id, correlation_id)` unique index still admits N copies while a rapid double-click regenerates identical child keys and collapses at the DB.
   - Per-copy lifecycle: each child is marked sent/acked/failed independently; the parent mirrors the terminal state so admin filters surface either level coherently.
   - Contract test: `src/test/printing/print-client-parent-child-chaining.test.ts` (3 tests). Full print suite: 150/150 pass.
3. **Admin surface.** Platform → Print Queue view backed by `print_jobs` with `queued → sent → acked | failed`; filter by business, branch, document type, correlation, state. Read-only.
4. **Ledger completion signal.** Wire agent's job-complete callback to write `acked_at` so the admin view distinguishes "sent to agent" from "printed".

## Then — Guardrails

- Architecture test: no page-level component calls `window.print()` or mounts a print `<iframe>` outside `pdfUtils`.
- Architecture test: every UI print entry point goes through `PrintClient.print` OR `usePrintOrPreview.generateDocument`.
- Extend `print-pdf-fifo-queue.test.ts` with parity test for raw-bytes path via mocked `AgentClient` — locks both pipelines to identical FIFO semantics.

## Non-goals (do not violate)

- No debounce, throttle, `setTimeout`, retry-until-it-works, or permanent button-disable on any print path.
- No new transport, no new edge-agent endpoint, no changes to `agent/src/routes/print.ts` queue semantics.
- No changes to statutory-paper-pinned generators (see ADR-0008).

## Load-bearing invariants — do not modify while doing routine work

`pdfUtils.pdfPrintQueue`, `PrintClient.recordInteractivePrint`, `PrintPreviewDialog.handlePrint`, `AgentClient._withEndpointLock`, `agent/src/routes/print.ts` FIFO.

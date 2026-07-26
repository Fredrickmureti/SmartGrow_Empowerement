
# Print Pipeline — Continuation Plan

## Verification of previous engineer's claims (independently confirmed)

| Claim | Evidence |
| --- | --- |
| P1 FIFO queue on PDF branch | `pdfPrintQueue` present in `src/services/printing/pdfUtils.ts`; test file exists |
| P2 Step 1 interactive-print ledger | `PrintClient.recordInteractivePrint`; `interactive-print-ledger.test.ts` green |
| P2 Step 2 direct-consumer migration + allowlist reconcile | ESLint allowlist trimmed; migrated files present |
| P3 Step 1 idempotency key | `PrintRequest.idempotencyKey`; `print-client-idempotency-key.test.ts` green |
| P3 Step 2 parent/child chaining | `print-client-parent-child-chaining.test.ts` green; RPC signature includes `p_parent_job_id` |
| P3 Step 3 admin surface | `src/apps/platform/hardware/HardwarePrintQueue.tsx` + route + nav wired |
| P3 Step 4 acked signal | `print_job_mark_acked_by_id` RPC exists in DB; `print-client-acked-signal.test.ts` green |
| Full print suite | `bunx vitest run src/test/printing` → 25 files / 158 tests pass |

**Conclusion:** the plan's status snapshot is accurate. No rework of shipped phases needed. Resume from **Guardrails** — the milestone the previous engineer marked "⏭ Next".

Pending work is **not** UI, business logic, or new pipelines — it is architecture lock-in and dead-code removal. This is exactly what the parent prompt asks for: one canonical pipeline, no drift.

## Status snapshot (post-continuation)

| Phase | Status | Evidence |
| --- | --- | --- |
| G1 — no shadow `window.print()` / hidden print `<iframe>` | ✅ shipped | `src/test/architecture/print-no-shadow-window-print.test.ts` |
| G2 — every UI entry through the chokepoint | ✅ shipped | `src/test/architecture/print-single-chokepoint.test.ts` |
| G3 — FIFO parity between PDF and raw-bytes transports | ✅ shipped | `src/test/printing/print-thermal-fifo-queue.test.ts` alongside `print-pdf-fifo-queue.test.ts` |
| C — collapse the shadow path (delete `useDocumentPrint`) | ✅ shipped | hook file deleted; `rg -n "from ['\"]@/hooks/useDocumentPrint" src` → 0 hits; `LegalRecipients` migrated to `printClient.download` / `printClient.printDocument` with `extraBody`; `PrintClient.download` and `printDocument` now ledger every intent |

## Phase G — Guardrails (architecture invariants)

Locks the single-pipeline invariant so a future refactor cannot silently reintroduce the drift that caused the original Sales-vs-Labels asymmetry.

### G1. No page-level `window.print()` / hidden print `<iframe>`

New test `src/test/architecture/no-page-level-window-print.test.ts`:
- Scans `src/{pages,components,features,apps}/**/*.{ts,tsx}` with fast-glob.
- Fails on `window.print(` or `.contentWindow?.print(` outside `src/services/printing/pdfUtils.ts`.
- Fails on any `document.createElement('iframe')` whose sibling code references `print`, outside `pdfUtils.ts`.
- Mirrors scaffolding from an existing `src/__tests__/architecture.*.test.ts` file.

### G2. Every UI print entry goes through the chokepoint

New test `src/test/architecture/print-single-chokepoint.test.ts`:
- Direct `hardwareClient.printRawBytes(` / `hardwareClient.printLabelBytes(` allowed only inside `src/services/printing/**` and `src/services/hardware/**`.
- Direct `pos.print.pdfBytes` / `generateDocumentPdf` / `generateDocumentEscPosBytes` allowed only inside `src/services/printing/**`.
- Every other caller must reach the pipeline via `PrintClient.print`, `usePrintOrPreview`, or `useDocumentPrint` (the remaining infra hook).

### G3. FIFO parity between the two transports

Extend `src/test/printing/print-pdf-fifo-queue.test.ts` (or a sibling `print-thermal-fifo-queue.test.ts`) with a raw-bytes parity case: 5 concurrent `PrintClient.print` calls with a mocked `hardwareClient.printRawBytes` observing per-endpoint FIFO — same assertion shape as the PDF test (5 sequential dispatches, no coalescing, failing job does not poison the chain). Pins both pipelines to identical semantics.

**Exit criteria:** `bunx vitest run src/test/printing src/test/architecture` all green; the three new tests fail if their invariant is violated (verified by a scratch mutation and revert).

## Phase C — Collapse the shadow path (P2 Step 3)

After guardrails ship, the remaining direct `useDocumentPrint` consumers are the only path that still bypasses `PrintClient`. They are all infra / settings, not business documents, but leaving them means the print-jobs ledger has blind spots.

Remaining consumers: `PrintSettingsPopover`, `CreditNoteDetailDialog`, `PrintingSettings`, `PrinterProfilesCard`, `LegalRecipients`.

Steps:
1. Add `PrintClient.download(documentType, documentId, filename?)` — same `generate-document` edge call as `useDocumentPrint.downloadPdf`, sharing the `print_jobs` insert + `markAcked` after the blob is delivered to the browser.
2. Add `PrintClient.printDocument(...)` companion for `LegalRecipients` (its `printDocument` shape).
3. Migrate the five callers onto the new methods. UI behavior unchanged; the ledger now records these too.
4. Simplify `src/hooks/usePrintOrPreview.ts` so it no longer wraps `useDocumentPrint`.
5. Delete `src/hooks/useDocumentPrint.ts`.
6. Prune `eslint-rules/no-document-print-shadow-path.js` allowlist to the two policy/profile hooks (or delete the rule if the allowlist empties).
7. Re-run the full print + architecture suite.

**Exit criteria:** `rg -n "from ['\"]@/hooks/useDocumentPrint" src` returns zero results; suite still green.

## Non-goals (unchanged from parent prompt)

- No debounce, throttle, `setTimeout`, retry-until-it-works, or permanent button-disable on any print path.
- No new transport, no new edge-agent endpoint, no changes to `agent/src/routes/print.ts` FIFO.
- No changes to statutory-paper-pinned generators (ADR-0008).

## Load-bearing invariants

`pdfUtils.pdfPrintQueue`, `PrintClient.recordInteractivePrint`, `PrintPreviewDialog.handlePrint`, `AgentClient._withEndpointLock`, `agent/src/routes/print.ts` FIFO, `print_job_mark_acked_by_id` RPC.

## Update `.lovable/plan.md`

After each phase lands, flip its row in the status snapshot and append a short "shipped" note beneath, matching the existing document conventions.

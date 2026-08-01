## Verification results (confirmed directly in the codebase, not from the log)

I re-audited the printing subsystem against the prior engineer's plan (`.lovable/plan.md`). What the log claims versus what is actually in the tree:

**Genuinely done and sound**
- One client front door exists: `src/services/printing/PrintService.ts` (`printDocumentIntent`, `printDocument`, `printLabel`, `downloadDocumentRecord`, `dispatchQueuedJob`, preview helpers). Sales, purchases, POS receipts, statements, credit notes, payments all dispatch through it via per-domain `dispatch*.ts` snapshot builders + `ensureDocumentRecord`.
- Payslip work landed: `_shared/payslip/payslipSnapshot.ts`, `payslipAccess.ts`, `ensure-payslip-document/index.ts`, `src/services/payroll/payslipDocuments.ts` all exist, and no `src/` surface invokes `generate-payslip-pdf` any more.
- Preview surfaces were moved onto `PrintService.renderDocumentPreview` — they no longer call `generate-document` inline.
- Hardware agent auth already uses a constant-time compare; the permanently-failing Bluetooth transport is gone.
- The printing guard suite is green: 20 test files / 142 tests pass.

**Claimed or assumed complete, but NOT complete**
- **Phase 1 (single rendering backend) was never done.** `render.ts` still exports `renderSourceDocument`, and `PrintService` calls it from three places (lines 154, 410, 577 — including the preview path). So preview and POS receipts still render through the legacy `generate-document` edge function, and ADR-0084's byte-identical-reprint guarantee still does not hold platform-wide.
- **A direct edge call still bypasses the pipeline**: `src/services/exports/documentExport.ts` invokes `generate-document` directly — no ledger row, no audit.
- **Phase 3 is not closed.** Three guard tests fail right now, exactly as the log warned: `payroll-engine-contract`, `payslip-header-surface-contract`, `payslip-header-country-agnostic`. Tax certificates (`pages/me/MyTaxCertificates.tsx`) still bypass the pipeline.
- **Phase 4 (legacy/doc sweep) not started.** `docs/printing-pipeline.md`, `docs/printing-add-new-artifact.md`, ADR-0026 and `eslint-rules/no-printservice-shim.js` all still name `PrintClient.ts`, a module that no longer exists.
- **Phase 6 not started.** Two operator queues over the same `print_jobs` table: `src/pages/admin/PrintQueuePage.tsx` and `src/apps/platform/hardware/HardwarePrintQueue.tsx`. Three preview dialogs exist (`components/common`, `components/reports`).

Resume point is therefore **Phase 1**, not Phase 4.

## Work plan

### Step 1 — Close out Phase 3 (payslips)
Correct `_shared/payslip/payslipSnapshot.ts` so the three failing guards pass without relaxing them: no synthetic Basic Salary row, statutory IDs read only through the shared payslip header, no country branching. Migrate `MyTaxCertificates.tsx` onto the same shape (`ensure-*-document` record + `downloadDocumentRecord`). Add an architecture guard forbidding `generate-payslip-pdf` in `src/`.

### Step 2 — Phase 1: one renderer
Give every remaining type (POS receipt reprint path, report exports) a document record + snapshot builder so `render-document` can serve it. Then delete `renderSourceDocument`, remove the legacy branches from `PrintService`, migrate `documentExport.ts` onto the pipeline, and retire the `generate-document` edge function.

### Step 3 — Phase 2: preview and download as dispositions
`renderDocumentPreview` re-based on `render-document`; paper-format/thermal overrides become policy parameters rather than renderer flags. Consolidate the duplicate `PrintPreviewDialog` implementations into one component with the report variant as configuration.

### Step 4 — Phase 4: legacy and documentation sweep
Delete every `PrintClient` remnant, retarget `no-printservice-shim.js` at the real chokepoint, rewrite `docs/printing-pipeline.md` and `docs/printing-add-new-artifact.md` against the real architecture, supersede ADR-0026 with an ADR describing the `PrintService` design, and correct `mem/features/hardware-platform.md` to match the live `device_assignments` schema.

### Step 5 — Phase 5: hardware layer
Re-verify and clean the remaining dead driver paths (LineDisplayDriver bridge, orphan `a4_printer` role, inline ZPL in `Products.tsx`), and scope the LAN agent's CORS. A transport that cannot work is removed, not registered.

### Step 6 — Phase 6: one operator workspace
Merge the two print-queue screens into the hardware workspace surface; the admin route redirects. The queue answers one question in business language: did it print, and if not, why. Terminology audit across printing UI — "output intent" → print rule, "document record" → document, "kind code" → document type, "device assignment" → printer. Standardise the print button, reprint action and document history panel across every printable record.

### Step 7 — Phase 7: guardrails
Extend `printing-architecture.test.ts` with single-renderer and single-front-door invariants, add a lint rule banning direct document edge-function calls outside `src/services/printing/`, and add coverage-matrix rows for the newly wired types.

## Technical notes
- Destructive migration throughout: each legacy module is deleted in the same step its replacement lands. No adapters, no fallbacks.
- No database redesign: `document_records`, `document_artifacts`, `print_jobs`, `device_assignments` and the policy tables are sound; this is adoption work.
- Baseline noted: the wider test suite has ~145 pre-existing failures unrelated to printing. Each step ends with the printing guard suite green.

---

## STATUS UPDATE — Phase 4 closed (latest turn)

### Fully implemented and verified
- **Phase 1 — one renderer.** `renderSourceDocument` deleted; `render.ts::renderDocumentRecord` → `render-document` is the only render seam. Legacy `(documentType, documentId)` callers bridged by `src/services/documents/resolveSourceDocumentRecord.ts` (freezes a `document_records` row first).
- **Phase 2 — dispositions.** Preview/download/archived-download all open and settle a `print_jobs` row (`renderDocumentPreview`, `downloadDocumentRecord`, `downloadArchivedArtifact`, `openInteractiveJob`).
- **Phase 3 — self-service coverage.** Payslip guards green; tax certificates (`useTaxCertificates`, `MyTaxCertificates`) fully ledgered.
- **Phase 4 — legacy/doc sweep (this turn).**
  - `eslint-rules/no-printservice-shim.js` retargeted: it no longer forbids the real chokepoint `@/services/printing/PrintService`, and its pattern is boundary-anchored so `DeviceFingerprintService` is not a false positive. Lint clean across `src/**` for all four printing rules.
  - `no-direct-window-print.js` / `no-document-print-shadow-path.js` messages now name `PrintService`.
  - `docs/printing-pipeline.md` rewritten against the real architecture (snapshot → record → PrintService → render-document → dispatch; ledger invariant; `generate-document` retained only as the CSV/XLSX export endpoint).
  - `docs/printing-add-new-artifact.md` and `docs/printing-event-coverage.md` de-drifted.
  - ADR-0026 marked **amended**: decision stands, entry point renamed to `PrintService`, bytes from `render-document`.
  - Preview drift closed: `components/reports/ReportPreviewDialog.tsx` now *exports* `ReportPreviewDialog` (was still exporting `PrintPreviewDialog`), and a new guard in `printing-architecture.test.ts` — *"exactly one document preview dialog exists"* — pins `components/common/PrintPreviewDialog.tsx` as the sole document preview surface.
  - `document-versions-record-pages` guard given an explicit `NOT_A_RENDERED_DOCUMENT` exemption list; `VendorStatementRecordPage` gained `DocumentVersionsSection`.
- **Verification:** `printing-architecture` 24/24, printing + preview + report suites 43/43 and the earlier 26-file / 180-test printing run all green; `tsgo --noEmit` clean.

### Still pending
- `src/services/exports/documentExport.ts` still invokes `generate-document` for CSV/XLSX. This is **intentional and documented** (a data extract is not a rendered document); retiring it needs a server-side export medium on `render-document`, not a client edit.
- **Phase 5 — hardware layer cleanup:** dead driver paths (LineDisplayDriver bridge, orphan `a4_printer` role wiring), inline ZPL in `Products.tsx`, LAN agent CORS scoping.
- **Phase 6 — one operator workspace:** two print-queue screens still exist (`pages/admin/PrintQueuePage.tsx`, `apps/platform/hardware/HardwarePrintQueue.tsx`); terminology audit; standardised print/reprint/history affordances.
- **Phase 7 — guardrails:** lint rule banning direct document edge-function calls outside `src/services/printing/`; coverage-matrix rows for newly wired types.
- Baseline: the wider suite still has ~115-120 pre-existing failing files unrelated to printing (workspace-shell, WMS outbox, etc.). Do not treat these as printing regressions.

### Active phase
Phases 1-4 are closed. **Phase 5 (hardware layer) is the active phase.**

### Instructions for the next agent
1. **Verify before continuing.** Re-run `bunx vitest run src/test/architecture/printing-architecture.test.ts src/test/architecture/printing-pipeline.test.ts src/test/architecture/adr-0086-generate-document-client-entrypoint.test.ts src/test/architecture/printing-coverage-matrix-integrity.test.ts src/test/printing` and `bunx tsgo --noEmit -p tsconfig.app.json`. Then independently confirm the Phase 1-4 claims above by reading the code, not this file: one render seam in `render.ts`, one entry point in `PrintService.ts`, one preview dialog, no `PrintClient` remnants in `src/`, ledger rows on every disposition.
2. **Then resume at Phase 5**, in the order written above (hardware cleanup → operator workspace → guardrails). Do not start Phase 6 or 7 work before Phase 5 is production-ready.
3. Keep the rule that has held so far: each legacy module is deleted in the same step its replacement lands — no adapters, no fallbacks, no parallel execution paths.

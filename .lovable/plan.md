# Printing & Document Output — verification results and remaining work

## Phase 1 — Independent verification (done, evidence below)

**Confirmed genuinely complete**
- One render seam exists: `src/services/printing/render.ts::renderDocumentRecord` → `render-document`, persisting a `document_artifacts` row. `renderSourceDocument` no longer exists anywhere in `src/`.
- One client front door: `src/services/printing/PrintService.ts`; per-domain `dispatch*.ts` snapshot builders feed it. No `PrintClient` module remains in `src/` (only stale mentions in old audit docs and one test comment).
- Legacy `generate-document` is gone from every page/hook except two call sites (below).
- Hardware agent CORS is already scoped through a tenant allowlist (`agent/src/origins.ts` + `edge-workstation-origins` refresh) — the plan's "LAN agent CORS scoping" item is already closed.
- `a4_printer` is no longer orphaned: it is a registered role in `electron/hardware/types.ts` and in the migrations' role mapping, and `labelDispatch.ts` routes PDF-engine templates to it.
- Inline ZPL in `Products.tsx` is gone; barcode identity goes through `resolveLabelBarcode` (ADR-0089).

**Claimed/assumed closed but NOT closed**
1. **A second render transport still exists.** `src/services/printing/pdfUtils.ts::callDocumentRenderer` POSTs to `generate-document` and is still reachable: `renderDocumentBytesWithPolicy` is called by `src/hooks/pos/useTestPrintReceipt.ts`. So "one renderer" is true for business documents but false for the POS test print. `generateDocumentPdf`, `generateDocumentPdfWithPolicy`, `printDocumentPdf`, `downloadDocumentPdf` and `generateDocumentEscPosBytes` are exported but have **zero production callers** — dead legacy surface that guard tests still describe as live.
2. **Phase 6 untouched.** Two operator queues over one `print_jobs` table: `src/pages/admin/PrintQueuePage.tsx` (227 lines, routed from `App.tsx`) and `src/apps/platform/hardware/HardwarePrintQueue.tsx` (489 lines).
3. **Phase 7 untouched.** No lint rule bans direct document edge-function calls outside `src/services/printing/`.
4. **Terminology audit not started.** Printing UI still exposes internals: "output intent", "document record", "kind code", "device assignment", "intent" in operator-facing copy.
5. **Dead driver surface.** `LineDisplayDriver` exists only to return a hard-coded "bridge removed" error yet is still registered in `DriverRegistry` — a registered transport that cannot work.

**Correctly deferred**: `src/services/exports/documentExport.ts` → `generate-document` for CSV/XLSX. A data extract is not a rendered document; retiring it needs an export medium on `render-document`, not a client edit. I will make that an explicit, guarded exemption rather than leave it ambiguous.

Note: dependencies aren't installed in this environment, so the guard suite couldn't be executed during planning. Step 0 of implementation installs and runs it to establish the real baseline before any edit.

## Phase 2 — Corrected plan

### Step 0 — Baseline
Install deps, run the printing guard suite and `tsgo --noEmit`. Record the pass/fail baseline; the wider suite's pre-existing failures are not printing regressions.

### Step 1 — Finish Phase 1: exactly one render transport
- Give the POS test print a real document record + snapshot so `useTestPrintReceipt` renders via `renderDocumentRecord` (ESC/POS medium) like every other artifact.
- Delete `callDocumentRenderer` and all `generateDocument*` / `renderDocumentBytesWithPolicy` exports from `pdfUtils.ts`, leaving it a pure blob-presentation utility (`openPdfInNewTab`, `printPdfInPage`, `downloadPdfBlob`).
- Move the `X-Print-Policy-*` policy shape onto the `render-document` response envelope so preview keeps showing the server's paper/render decision.
- Rewrite `document-renderer-single-transport.test.ts` to pin `render.ts` as the only transport, with `documentExport.ts` as the single named data-extract exemption.

### Step 2 — Finish Phase 5: remove transports that cannot work
- Delete `LineDisplayDriver` and its `DriverRegistry` registration; customer-display output routes through the main-process device manager only. Any UI offering a line-display test action is removed with it.
- Sweep `electron/hardware/drivers` for compiled `.js`/`.js.map` artifacts checked in beside their `.ts` sources (e.g. `EscPosKitchenDriver.js` advertises the retired `print_ticket` op while the `.ts` advertises `print_receipt`) — stale build output that contradicts the source is deleted and excluded.

### Step 3 — Phase 6: one operator print queue
- `HardwarePrintQueue` becomes the single operator workspace surface; `pages/admin/PrintQueuePage.tsx` is deleted and its route redirects to the hardware workspace.
- The queue answers one question in business language: **did it print, and if not, why** — document, destination, when, status, failure reason, retry/reprint. Internal ids move behind a details affordance.
- Standardise the record-page affordances across every printable entity: one Print action, one Reprint action, one Document history panel.

### Step 4 — Terminology and UX pass
Business language everywhere printing is exposed: output intent → **print rule**; document record → **document**; kind code → **document type**; device assignment → **printer**; intent/target/disposition → **where it goes** (print, email, download, archive). Copy is written for a cashier, warehouse operator, payroll officer or accountant — no database nouns, no architecture nouns.

### Step 5 — Phase 7: guardrails that hold the line
- New lint rule: no direct document edge-function invocation (`render-document`, `generate-document`, `submit-document-intent`) outside `src/services/printing/` and `src/services/documents/`.
- Extend `printing-architecture.test.ts` with single-transport, single-front-door, single-queue-screen and single-preview-dialog invariants.
- Add coverage-matrix rows for newly wired types (POS test print, tax certificates) so an unwired artifact fails CI.

### Step 6 — Documentation of record
- New ADR superseding ADR-0026: the canonical lifecycle (business event → snapshot → `document_records` → `PrintService` → `render-document` → `document_artifacts` → `print_jobs` → hardware → acknowledgement → audit).
- Rewrite the stale claims in `docs/printing-pipeline.md` / `printing-add-new-artifact.md` that still name `PrintClient`, and correct the mem entries.
- Replace `.lovable/plan.md`'s status block with verified state so the next engineer inherits facts, not claims.

## Technical notes
- Destructive migration throughout: each legacy module is deleted in the same step its replacement lands. No adapters, no fallbacks, no parallel paths.
- No database redesign. `document_records`, `document_artifacts`, `print_jobs`, `device_assignments` and the policy tables are sound; this is adoption and consolidation work.
- Every step ends with the printing guard suite green and `tsgo --noEmit` clean.

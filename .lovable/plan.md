
# Enterprise Printing Consolidation — One Pipeline

## What the investigation found

There are **three** live printing architectures, not two.

**A. Synchronous hardware path (the reference implementation)** — labels and POS label/receipt bytes:
`useLabelPrint` / `PrintLabelButton` → `printLabelByTemplate` (`src/services/printing/labelDispatch.ts`) → `execForIntent` (`src/services/hardware/execForIntent.ts`) → `resolve_device` RPC → `hardwareClient.execAssignment` → transport router → agent `/print` (`agent/src/routes/print.ts`, per-endpoint FIFO queue).
It succeeds because: device resolution is one server-authoritative RPC; dispatch is immediate and in-process; ordering is guaranteed by the agent's per-endpoint FIFO queue; failures return typed refusals instead of falling back. Its weakness: it writes **no** durable job row, so there is no ledger, no retry, no cross-device observability.

**B. Deprecated `PrintClient`** (`src/services/printing/PrintClient.ts`, 780 lines) — its own policy resolver + LRU cache, its own copies fan-out, its own ledger writes, its own transport branching (Electron pipe / browser iframe / thermal), plus `usePrintOrPreview`, `usePrintWithFallback`, `reprintClient`. Marked `@deprecated` but still imported by POS, FixedAssets, HR payroll, POSReports, ReprintButton, hardware admin.

**C. Async document-intent spool** — Sales/Purchases:
page → `ensureDocumentRecord` → `submitDocumentIntent` → `submit-document-intent` edge fn → `print_jobs` rows → **pg_cron drains every ~30s** → `dispatch-print-jobs` → `render-document` → `hardware_command_queue` → `SharedCommandQueueWorker` in a browser tab.
This is the direct cause of the reported symptoms: a click produces a queued row that only moves on the next cron tick, only renders if the drainer succeeds, and only reaches hardware if some client tab is running the command-queue worker. Plus a genuine shadow path: `PrintPreviewDialog` calls `generate-document` directly, bypassing the spool entirely.

Duplication inventory: 3 dispatch entry points, 2 device-resolution implementations, 2 policy resolvers, 3 job/ledger writers, 2 render invocations (`generate-document` vs `render-document`), 2 hardware transports (direct `execAssignment` vs `hardware_command_queue`).

## Canonical architecture

Mature ERP spools (SAP output management, Odoo `ir.actions.report`, D365 document routing, Square/Lightspeed station printing) share one shape: **every print is a persisted spool request, dispatched immediately by the requester, with the background worker acting only as a recovery sweeper — never as the primary path.** Latency and auditability are not a trade-off; you get both by writing the job row *then* dispatching in the same call.

One pipeline, no exceptions:

```text
Business Event
  ↓  ensureDocumentRecord            (document_records)
  ↓  resolveOutputIntents            (output_intents → targets)
  ↓  enqueuePrintJobs                (print_jobs, status=queued, idempotency key)
  ↓  renderArtifact                  (document_artifacts; pdf | escpos | zpl)
  ↓  resolveDevice                   (resolve_device RPC → device_assignments)
  ↓  execAssignment                  (transport router → agent → printer)
  ↓  ack / fail                      (print_jobs terminal state)
```

Labels, receipts, invoices, POs, statements differ **only in**: document type, render engine, and output-intent rows. Same service, same functions, same tables.

## Implementation

**1. New canonical service — `src/services/printing/PrintService.ts`**
Single exported surface:
- `print(request)` — the only way anything prints. Takes `{ documentType, documentId | payload, intent, orgId, businessId, branchId, idempotencyKey, copies? }`.
- `reprint(jobId)`, `download(request)`, `preview(request)` — all resolve through the same job/artifact machinery; preview reads a `document_artifacts` row instead of re-invoking a render endpoint.

Internally composed of small single-responsibility modules (no wrappers around old code):
- `jobs.ts` — enqueue/claim/ack/fail against `print_jobs` via the existing SECURITY DEFINER RPCs.
- `render.ts` — one render call (`render-document`) producing a `document_artifacts` row for every engine.
- `dispatch.ts` — `resolve_device` → `hardwareClient.execAssignment`, i.e. path A promoted verbatim; this is the *only* hardware caller.
- `policy.ts` — one policy resolver (`document_print_policies`), replacing `PrintClient.resolvePolicy` and the ad-hoc label workflow hints.

**2. Make dispatch immediate, keep the ledger**
`print()` writes the job row, renders, dispatches synchronously and acks — same click-to-printer latency as labels today. `dispatch-print-jobs` is retained *only* as a recovery sweeper for rows still `queued`/`failed` past their back-off, and `hardware_command_queue` is used only for jobs targeting a device this session can't reach (offline/other-station), which is what it was designed for.

**3. Migrate labels and POS onto the service**
`printLabelByTemplate` keeps template/media/geometry/barcode resolution (ADR-0087/0088/0089/0090 contracts stay intact) but becomes a *renderer* registered with `PrintService`, not a dispatcher. `dispatchPosReceipt` keeps its frozen-snapshot rule and calls `PrintService.print`. Label jobs then get ledger rows for the first time — same observability as documents.

**4. Migrate document callers**
`Invoices`, `Estimates`, `DeliveryNotes`, `SalesOrders`, `SalesReturns`, `ProformaInvoices`, `Bills`/`PurchaseOrders`, `dispatchVendorStatement`, `dispatchGoodsReceipt`, `FixedAssets`, HR payroll recipients, `POSReports` reprint, warehouse label callers — all call `PrintService`. `PrintPreviewDialog` renders an artifact, never `generate-document`.

**5. Deletions (mandatory, no fallbacks left behind)**
- `src/services/printing/PrintClient.ts`
- `src/hooks/usePrintOrPreview.ts`
- `src/hooks/printing/usePrintWithFallback.ts`
- `src/services/printing/reprintClient.ts` (folded into `PrintService.reprint`)
- `src/components/pos/PrintFallbackDialog.tsx` and the ask_user/preview-fallback branches
- `PrintClient`'s policy cache, copies fan-out, transport branching, and ledger writers
- direct `generate-document` invocation from app code; the edge function is retired in favour of `render-document`

**6. Guardrails updated to match**
Existing ESLint rules are re-pointed at the new chokepoint: add `no-print-outside-printservice` (only `src/services/printing/*` may call `hardwareClient`, `execForIntent`, `submitDocumentIntent`, or `printPdfInPage`); tighten `no-direct-generate-document-in-pages` to zero escape hatches; keep the ZPL/ESC-POS/`window.print` bans. Architecture tests that assert the old two-path world are rewritten to assert the single path, and a coverage test enumerates every printable document type and proves it reaches `PrintService`.

**7. ADR**
`docs/adr/0101-single-enterprise-print-pipeline.md` records the decision, supersedes ADR-0026 and the Wave 5–7 transitional notes, and deletes the stale audit guidance that described two sanctioned paths.

## Sequencing

1. Build `PrintService` + its four internal modules against the existing tables; prove it with the label path (already deterministic) and receipts.
2. Move Sales/Purchases document callers over; delete `usePrintOrPreview` and preview fallbacks as each page migrates.
3. Move remaining callers (HR, fixed assets, warehouse, reprints, hardware admin test prints).
4. Delete legacy modules, retire `generate-document`, demote the cron drainer to sweeper.
5. Rewrite guardrail rules/tests and land the ADR.

## Verification

- Rapid consecutive clicks on an invoice behave exactly like rapid label clicks: N ordered jobs, N printed outputs, no duplicates (idempotency key collapse) and no stuck `queued` rows.
- Every document type produces a `print_jobs` row with a terminal state and an artifact.
- `rg` shows exactly one caller of `hardwareClient.execAssignment` in the app.

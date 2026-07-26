# AccrualFlow Print Pipeline — Architectural Report

Read-only investigation, no code changed. Every claim below is anchored to a file:line read this turn.

## TL;DR

There are **two distinct print pipelines** in the ERP, and they behave differently on rapid clicks for structural, not incidental, reasons:

- **Labels / thermal / raw-bytes path** (Products, shelf/product labels, ESC-POS receipts) is protected by **two real serialization layers** — a client-side per-endpoint mutex in `AgentClient` and a server-side per-endpoint FIFO queue in the local agent. Rapid jobs are queued and delivered in order.
- **A4 / PDF document path** (Sales, Purchases, HR docs) never reaches either queue. It ends at a hidden `<iframe>` + native browser `window.print()` dialog. Rapid clicks are silently absorbed by a React `disabled={isPrinting}` boolean, so clicks 2..N never fire `onClick` and no job is ever created.

Symptom: "first invoice prints, next 3 disappear, no errors" is not a bug in a queue — **there is no queue on that path**. It is React's `disabled` attribute masking the fact that no dispatch layer exists.

## Verified pipelines

### A. Product label (survives rapid clicks)

```
Products.tsx:912 menu item / PrintLabelButton.tsx:37 (no disable guard)
  → useLabelPrint.print()                     src/hooks/inventory/useLabelPrint.ts:78
  → printLabelByTemplate()                    src/services/printing/labelDispatch.ts:266
  → hardwareClient.exec({op:'print_label', idempotencyKey})  HardwareClient.ts:128
  → AgentClient._withEndpointLock             src/services/hardware/local-agent/AgentClient.ts:87
      (per-endpoint mutex; documents the prior "burst of invoices stopped after the first" fix at :143)
  → POST /print on local agent
  → endpointQueues FIFO                       agent/src/routes/print.ts:20-47
  → TCP 9100 → printer
```

Two independent queues; each click carries its own `idempotencyKey` (`labelDispatch.ts:387`).

### B. Sales invoice / A4 documents (drops rapid clicks)

```
InvoiceListTable.tsx:162 → Invoices.tsx:284 handleDownloadPDF
  → usePrintOrPreview.generateDocument         src/hooks/usePrintOrPreview.ts:64
  → PrintClient.print({intent:'a4_document'})  src/services/printing/PrintClient.ts:177
     (correlationId at :251 is a 2s-bucketed ledger key, NOT a dedup cache)
  → fallback: useDocumentPrint opens <PrintPreviewDialog>  useDocumentPrint.ts:38
  → PrintPreviewDialog Print button            PrintPreviewDialog.tsx:698
       disabled={isPrinting || showLoading}    ← swallows clicks 2..N
       handlePrint sets isPrinting=true        :321
  → printPdfInPage(blob)                       src/services/printing/pdfUtils.ts:41
       new hidden <iframe>, iframe.contentWindow.print()
       promise resolves only on 'afterprint' or 60s timeout  :96-114
  → native browser print dialog → OS spooler → printer
```

Never touches `hardwareClient`, `AgentClient`, or the agent FIFO queue for `render_mode: pdf` (the default). Only reaches the raw-bytes queue when the resolved policy is `escpos`/`zpl` (`PrintClient.ts:209`).

Same shape for Bills, CreditNotes, DeliveryNotes, Estimates, ProformaInvoices, PurchaseOrders, PurchaseReturns, SalesOrders, SalesReturns, CustomerPayments — all on the `useDocumentPrint` allowlist in `eslint-rules/no-document-print-shadow-path.js:29-44`.

## Root cause (verified)

`PrintPreviewDialog.tsx:320-390` + `pdfUtils.ts:41-114`:
1. Click 1 sets `isPrinting=true`, opens a hidden iframe, calls `iframe.contentWindow.print()`.
2. The returned promise only settles on `afterprint` (dialog dismissed) or the 60s safety timeout.
3. While it is pending, the Print button is `disabled` — React drops all further `onClick` events at the DOM level. No job is created, no error is thrown.
4. No client- or service-level queue exists on this path to hold them; `PrintClient`'s ledger is audit-only, not a dispatch queue.

Labels don't hit this because `PrintLabelButton.tsx:37-64` has no `disabled` guard AND every click is caught downstream by two real per-endpoint queues.

Rejected hypotheses (checked, not the cause):
- Iframe reuse / src overwrite — each `printPdfInPage` call builds a fresh iframe (`pdfUtils.ts:61-69`).
- Shared in-flight promise / dedup map in `useDocumentPrint` or `generate-document` — no such map exists.

Open (unverified) contributor: whether the browser's own modal `window.print()` swallows a click racing with dialog open. Not needed to explain the symptom; the React guard alone is sufficient.

## Architectural drift

- Two pipelines with materially different concurrency guarantees exist because the raw-bytes/agent path was hardened during the label + ESC-POS work (see AgentClient's own comment at `:143` and agent `print.ts:16-19`) while the A4 path was left on the legacy `useDocumentPrint` → `printPdfInPage` iframe pattern.
- The `no-document-print-shadow-path` ESLint rule explicitly calls `useDocumentPrint` the "legacy shadow path" and freezes the consumer list — signalling intended-but-unfinished migration to `PrintClient`.
- `PrintClient` has a print-job ledger (`print_job_insert`/`_mark_sent`/`_failed`) but no dispatch queue and no in-flight coalescing keyed by `(documentType, documentId)`.

## Canonical direction (proposed, no code yet)

Adopt one canonical print submission pipeline for **every** printable artifact, modelled on what already works for labels:

```
UI submit(job)  →  PrintClient (single-flight + queue)  →  Transport selector
                                                             ├─ raw-bytes → AgentClient mutex → agent FIFO
                                                             └─ pdf       → single-flight iframe dispatcher
                     ↓
              print_jobs ledger (state machine: queued→sent→ack|failed)
```

Concretely, the target invariants the codebase should enforce (mirroring what labels already have):

1. **Every UI print action is a fire-and-forget submit** returning a `jobId`. No component owns "am I currently printing?" — that is queue state, queried by `jobId`.
2. **Single-flight + FIFO in `PrintClient`** keyed by `(documentType, documentId, destinationId)` for the PDF branch, exactly analogous to `AgentClient._withEndpointLock` for the raw-bytes branch. Rapid clicks either coalesce (return existing `jobId`) or enqueue (new `jobId`) — never silently no-op.
3. **Idempotency key per submission** (already exists for labels via `labelDispatch.ts:387`; extend to `PrintClient.print()`).
4. **Ledger becomes the source of truth for button state**: `disabled` is driven by `jobId` status, not a local `isPrinting` boolean.
5. **`useDocumentPrint` is removed from the allowlist one module at a time**, each migration switching the module to `PrintClient` and deleting its local `isPrinting` flag.
6. **Architecture test** locking rapid-click behavior: submitting N prints for the same document in <100ms produces N ledger rows (or 1 coalesced row with N requestors), never 1 dispatched + N-1 lost.

## Deliverables of this plan

This plan is the report. No code changes are proposed in it. Implementation, if approved, would be sequenced as separate plans:

- **Plan P1** — Add single-flight + FIFO queue and idempotency to `PrintClient.print()` for the `pdf` render mode; drive `PrintPreviewDialog`'s Print button off ledger state instead of `isPrinting`. Add the rapid-click architecture test. Migrate `Invoices` first as canary.
- **Plan P2** — Migrate remaining `useDocumentPrint` consumers (Bills, CreditNotes, DeliveryNotes, Estimates, ProformaInvoices, PurchaseOrders, PurchaseReturns, SalesOrders, SalesReturns, CustomerPayments, HR docs) to `PrintClient`; shrink the ESLint allowlist to empty; delete `useDocumentPrint`.
- **Plan P3** — Unify job identity (correlation-id → idempotency-key) across raw-bytes and PDF branches; expose `print_jobs` in a Platform → Print Queue admin view for observability.

## What this plan explicitly does NOT do

- No debounce, throttle, `setTimeout`, or arbitrary click-guards.
- No patch to the invoice printing screen in isolation.
- No change to the agent or the label path — they are the reference implementation.

Approve to move to Plan P1 (queue + single-flight in `PrintClient` for the PDF branch, canary on Invoices), or request revisions to the architecture direction above.

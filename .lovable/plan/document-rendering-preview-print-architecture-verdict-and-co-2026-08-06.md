# Document Rendering, Preview & Print — Architecture Verdict and Convergence Plan

## Verdict first

The printing and hardware layers are **not** the problem. They are already
correct and must not be touched. The drift lives one layer up, in how the
document *bytes* are produced.

What the trace confirmed as production-grade and untouched by this work:

- `PrintService` → policy → `print_jobs` ledger → `render.ts` → `dispatch.ts`
  → `execForIntent` → `resolve_device` RPC → drivers/transports. One seam,
  no fallback guessing, single-writer ledgers.
- ESC/POS, thermal, ZPL labels, printer routing, `document_print_policies`.
- No app code imports `pdf-lib`, `bwip-js` or raw `qrcode`; no stray
  `window.print()`. ADR-0085 is genuinely enforced today.

## The actual defect

The platform has **two document backends split by disposition instead of by
document**:

```text
Business record
   |
   +-- PRINT / PREVIEW --> ensureDocumentRecord (frozen snapshot)
   |                          --> render-document --> document_artifacts
   |
   +-- EMAIL / EXPORT ------> generate-document (re-fetches live data)
                                 --> PDF / CSV / XLSX, no artifact
```

`generate-document` (4,818 lines, 20 `fetchX` functions) re-queries the
database at send time. `render-document` renders the snapshot that was
frozen at submit time. Both end at the same `pdfGenerator.ts` drawing code,
so the *layout* agrees — but the *content* can disagree.

Consequence, in business terms: the invoice PDF a customer receives by email
can differ from the invoice that was printed and archived, because it was
rebuilt from data that has since changed. Every snapshot builder in
`src/services/documents/snapshots/*` carries a comment admitting it "mirrors"
a legacy fetcher — that is fourteen field projections maintained twice.

No mature ERP does this. SAP, Oracle, Dynamics, NetSuite and Odoo all
converge on the same rule, and it is the rule this plan adopts:

> **One canonical artifact per (document, medium, template version).
> Disposition — print, preview, email, export, archive — selects an
> artifact. It never selects a renderer.**

Preview is therefore not a renderer either. Preview is "show me the artifact
this document would produce", which is why the existing `PrintPreviewDialog`
(server bytes in a viewer) is already right, and the statement screens are
not.

## Secondary findings

- **Statements** (`StatementPreview.tsx`, `VendorStatementPreview.tsx`) are
  hand-built HTML tables with their own totals, wholly disconnected from the
  statement PDF. This is a genuine second representation of one document.
- **Payslip email** uses a third generator (`generate-payslip-pdf`).
- **Kitchen tickets** bypass `render-document` entirely.
- **Client-side policy** (`policy.ts`) duplicates the server resolver. This
  one is fine — it is advisory, the server overrides and reports `coerced`.
  Documenting it, not changing it.
- **POS receipts stay where they are.** A receipt is the same document class
  on a different medium, and it already flows through the same snapshot →
  render-document → artifact path. No special-casing is warranted.

## Plan

**Phase 1 — Email consumes the canonical artifact.**
Rewrite the PDF acquisition in `send-document-email` to resolve the source
document to a `document_records` row and call `render-document`, reusing the
existing artifact when one exists. Thermal→A4 coercion for attachments stays,
but becomes a *paper override* on the same renderer rather than a jump to a
different backend. Route the payslip branch through the same call.

**Phase 2 — Exports become a medium, not a backend.**
Add `csv`/`xlsx` renderers to `_shared/rendering/mediumRegistry`, fed by the
frozen snapshot. Repoint `src/services/exports/documentExport.ts` at
`render-document`. Exported figures then provably match the printed ones.

**Phase 3 — Retire the legacy fetchers.**
With email and export moved, the 20 `fetchX` projections in
`generate-document` have no callers. Delete them and the function's PDF /
ESC-POS branches; fold the kitchen-ticket branch into the ESC/POS medium
renderer. The snapshot builders become the single projection layer.

**Phase 4 — Statements join the protocol.**
Keep the HTML tables as what they actually are — an interactive ledger
drill-down — and stop treating them as the document preview. Wire the
statement record pages' Preview action to the canonical artifact through the
same dialog every other document uses.

**Phase 5 — Ratchet it shut.**
Architecture tests + ESLint rules asserting: only the rendering engine may
import `pdfGenerator`; no edge function other than the engine may emit
document bytes; every document kind has exactly one snapshot builder; email
and export may not name a render backend.

**Phase 6 — Extension contract.**
One ADR plus a short guide: to make a document printable, a future module
(Finance, Inventory, Manufacturing, HR…) writes a snapshot builder and a
`document_kinds` row. Nothing else. No renderer, no preview screen, no print
code.

## Technical notes

- Nothing in `src/services/printing/**`, `src/services/hardware/**`,
  `electron/hardware/**`, `agent/**` or `_shared/escpos/**` changes behaviour.
- `_shared/pdfGenerator.ts` keeps drawing the pixels; only its callers change.
- Artifact reuse is content-addressed (`content_sha256`), so Phase 1 reduces
  render load rather than adding to it.
- Phase 3 is the only destructive step and runs after 1 and 2 have removed
  every caller, verified by grep and the Phase 5 guards.
- Each phase ends green on typecheck and the existing architecture suite.

## Verified follow-up concerns — 2026-08-06

- **Receipt schema drift reached production preview.** The canonical payment
  receipt snapshot projected `payments.currency`, although that column does not
  exist. The immediate correction removes that projection and derives currency
  only from invoice allocations or `businesses.base_currency`; missing or mixed
  currency is now surfaced as an integrity error instead of being masked with
  `USD`. A ratchet test protects the removed-column contract.
- **Receipt generation is still duplicated until Phase 3.** The client snapshot
  builder and `generate-document::fetchReceipt` both implement allocation,
  currency and totals rules. The latter still contains dead references to
  dropped legacy fields such as `payment.currency` / `payment.invoice`. Do not
  patch those branches independently; remove the fetcher when email/export have
  moved to the canonical artifact as already planned.
- **The `receipt` compatibility discriminator is architectural debt.** Invoice
  actions pass an invoice id while payment actions pass a payment id, forcing
  runtime anchor guessing and a synthetic `payment_receipt_invoice` record
  identity. A follow-up must make the action resolve an explicit payment/allocation
  identity before invoking the single `payment_receipt` document kind, then
  delete the compatibility registry entry rather than preserving both names.
- **Settlement totals have two authorities today.** Receipt snapshots derive
  applied and unapplied amounts from `payment_allocations`, while payment list,
  detail, reversal and deposit workflows consume `payments.applied_amount` and
  `payments.outstanding_amount`. Add an integrity report/ratchet proving those
  values reconcile across apply, void, unreconcile and reapply transitions;
  discrepancies must be surfaced, never silently selected from one side.

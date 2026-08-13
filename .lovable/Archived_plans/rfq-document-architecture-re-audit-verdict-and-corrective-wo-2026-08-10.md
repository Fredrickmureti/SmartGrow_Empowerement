# RFQ Document Architecture — Re-audit Verdict and Corrective Work

## What the evidence actually shows

I parsed both attached artifacts and traced the pipeline end to end against the
live database. The previous engineer's *code and data* work is largely present
and correct. What was never done is the step that makes it real.

Confirmed by direct inspection:

| Layer | State | Evidence |
| --- | --- | --- |
| RFQ snapshot contract | Correct, RFQ-native | `src/services/documents/snapshots/purchasesRfq.ts` emits no price/tax/total and hard-throws on forbidden monetary keys |
| Requisition snapshot | Correct, internal-only | `purchasesRequisition.ts` — quantities only, no supplier block |
| Frozen records in DB | Correct | `document_records` for RFQ-0002 and PR-2026-0001 carry `document_type: rfq` / `purchase_requisition`, no `total` key |
| Templates in DB | Correct | `document_template_ast`: `purchases.rfq` v2 active with `layout: solicitation`; `purchases.requisition` v1 with `layout: requisition` |
| Renderer routing (source) | Correct | `_shared/rendering/renderers/pdf.ts` routes both kinds to `generateSolicitationPdf` / `generateRequisitionPdf` before any invoice path |
| **Deployed renderer** | **Stale — this is the defect** | see below |

Why the deployed renderer is the culprit, not the model:

- The PDF was produced by `render-document` (function booted 23:34:27, artifact
  stamped 23:34:28) yet came out invoice-shaped, while the record it rendered
  from contains no monetary fields at all. The invoice ladder therefore cannot
  come from the snapshot — it comes from renderer code that ignores the
  procurement layouts.
- `Total KES NaN` is exactly what the generic invoice layout produces when it
  sums a `total` field that does not exist. That is the fingerprint of the old
  code path, not of the current source.
- `shouldPersistArtifact` in source allowlists `rfq` and `requisition`, yet
  `document_artifacts` has zero rows for either — while `purchases.bill`
  persisted normally at 22:20. The running bundle predates the RFQ work
  (migrations landed 22:46 and 23:15).

Conclusion: the RFQ business model, contract, template and routing were built
but the edge functions carrying them were never redeployed. Everything the
user is looking at is being drawn by the previous generation of the renderer.

## Corrective work

### 1. Ship the engine that already exists (first, because it gates verification)
Deploy `render-document` (and any function sharing `_shared/rendering`,
`_shared/pdf`, `_shared/documents` — notably `generate-document`,
`process-scheduled-reports`, `outbox-dispatcher`) so the deployed bundle matches
source. No new engine, no second renderer.

### 2. Re-render and inspect the real artifact
Regenerate RFQ-0002 and PR-2026-0001 through the canonical path, download the
actual bytes, and read them. Acceptance is read off the artifact, not off a
compile:
- absent: `Bill To`, Price/Tax/Amount columns, any total, `NaN`,
  "Thank you for your business!"
- present: RFQ identity + revision, issue date, response deadline, buyer block,
  invited supplier, requirement lines (SKU, description, specification, qty,
  UOM, required-by), delivery location, response instructions, originating
  requisition.

If the fresh artifact is still wrong, the remaining trace points are the preview
surface's template resolution and any tenant-scoped template override; those get
investigated before anything else is changed.

### 3. Close the real gaps the deploy will expose
- **Artifact persistence / revision integrity.** With the correct code running,
  confirm an RFQ render actually writes `document_artifacts`, and that a
  revision bump produces a distinct immutable artifact rather than mutating the
  issued one. Fix the persistence path if it does not.
- **NaN hardening at the renderer, separately from the RFQ fix.** The money
  formatter must never emit `NaN`/`undefined`/`null` for any kind: an invalid
  numeric input is a render error or a blank cell, never printed text. This is
  a cross-document defect and is fixed once, centrally.
- **Download must be a file download** of the canonical artifact bytes, not a
  browser print dialog; print and email must consume that same artifact.

### 4. Audit the sibling procurement documents
Check Purchase Order, Goods Receipt, Vendor Bill and Supplier Quotation for the
same failure mode — title changed, invoice structure retained — and correct only
those that are genuinely mis-shaped. Healthy documents are left alone.

### 5. Guardrails so this cannot silently regress
- RFQ template contract test (no `line_items` preset, no `billTo` party role, no
  totals block) — extend the existing assertion so it runs in CI, not only in a
  Deno test nobody executes.
- Artifact integrity test: rendered RFQ bytes must not contain `NaN`,
  `undefined`, `null`.
- Requisition intent test: internal kind cannot carry an `email` intent.
- Snapshot parity test: TypeScript builder vs the SQL twin
  `rfq_ensure_document_record` emit the same keys.
- Revision test: rev 1 and rev 2 yield distinct artifacts.
- **Deployment freshness guard**: a check that fails when `_shared` render code
  is newer than the deployed function, since that single omission is what
  produced this entire incident.

## Technical notes

- No new PDF generator, template engine, snapshot system, email or print path is
  introduced. `render-document` + `_shared/rendering` remains the one engine.
- Governance, tenancy and supplier access are untouched; RFQ document actions
  keep flowing through the existing approval/print/email architecture.
- `rfq_items.target_price` is an internal bid-scoring ceiling and stays absent
  from the snapshot — it is excluded, not zeroed.
- Completion will be claimed only after a real regenerated PDF has been read.

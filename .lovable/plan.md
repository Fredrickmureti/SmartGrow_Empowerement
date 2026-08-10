# Procurement Document Architecture — Audit and Convergence Plan

## What the audit found

The platform already has one canonical document engine. Procurement must consume it. But one of the three documents is missing entirely, one is invoice-shaped, and one is fine.

### The canonical engine (do not rebuild)

```
Business event
   -> snapshot builder (src/services/documents/snapshots/*)
   -> ensure_document_record RPC  (frozen snapshot in document_records)
   -> document_template_ast (per kind, scope-resolved)
   -> rendering engine (_shared/rendering/engine.ts)
   -> document_artifacts (sha256, versioned, canonical bytes)
        |-- Print   : PrintService -> print_jobs -> dispatch.toDevice/toPage
        |-- Download: PrintService -> dispatch.toDownload
        |-- Email   : send-document-email -> resolveCanonicalPdf -> document_emails
```

Print, download and email are already three separate consumers of the same artifact. `resolveCanonicalPdf` exists precisely so the emailed PDF is byte-identical to the printed one. No coupling defect was found in this seam: `PrintDisposition` is `print | download`, email is not a print disposition, and four ESLint ratchets already block shadow paths.

A second, legacy engine (`generate-document` with `FETCHER_MAP`, live re-fetch, no snapshot) still exists and serves older call sites. Procurement will not add anything to it.

### Per-document verdict

| Document | Kind row | Snapshot builder | Template AST | Print | Download | Email | Verdict |
|---|---|---|---|---|---|---|---|
| Requisition | absent | absent | absent | none | none | none | Missing entirely |
| RFQ | `purchases.rfq` | `purchasesRfq.ts` + SQL twin | invoice-shaped | none in UI | none in UI | auto on release only | Wrong document identity, no staff surface |
| Vendor Bill | `purchases.bill` | `purchasesBill.ts` | seeded | wired | via preview | wired | Healthy |

### The RFQ regression, confirmed

The seeded RFQ template is literally an invoice skeleton: a `party` block with `role: vendor`, a `meta` block of `number / date / due_date / currency`, and `table preset: line_items` — a priced table whose money columns are zeroed. The snapshot mirrors it with `subtotal/tax_amount/discount_amount/total = 0` and per-line `unit_price/tax_rate/tax_amount/line_total = 0`.

That is the exact Customer-Statement failure mode: renaming the title to "REQUEST FOR QUOTATION" over an invoice information architecture. A supplier receives a document with a zero-value price column and a "due date" that is actually a response deadline. It also omits everything an RFQ needs: revision identity, specifications, required-by date, delivery location, response instructions, and a buyer contact.

Note: prices being redacted is correct and deliberate — `rfq_items.target_price` is the buyer's internal ceiling. The defect is the priced *shape*, not the redaction.

### The Requisition question

A requisition is an internal demand-origin record: requester, cost centre, project, analytic account, justification, need-by date, destination branch/warehouse, quantities and UOM, plus an approval trail. It is never supplier-facing. It warrants a printable/downloadable document for internal approval, audit and attachment to the sourcing file — but must not be emailable to a supplier. Its audience is internal only.

## What will be built

### 1. RFQ — correct sourcing document identity

Replace the invoice-shaped AST with an RFQ-native block layout and widen the snapshot to carry sourcing facts:

- header: issuing legal entity, branded
- solicitation block: RFQ number, **revision/version**, issue date, **response deadline**, currency, buyer contact
- supplier block labelled as invited supplier, not "Bill To"
- requirements table: line no, SKU, description, **specification**, quantity, UOM, **required-by date** — no price, tax or total columns at all
- delivery location block (destination branch/warehouse)
- commercial requirements and response instructions
- terms, branded footer

Extend `purchasesRfq.ts` and its SQL twin `rfq_ensure_document_record` in step (they are already documented as twins) so both emit the same new fields. Money keys are dropped rather than zeroed.

### 2. RFQ — revision-stable artifacts

`rfqs.version` and `rfq_revisions` already exist. The frozen snapshot and the emitted artifact will carry the revision, and a revision bump must produce a new `document_records` freeze rather than mutate the issued one, so Rev 1 stays retrievable after Rev 2 ships.

### 3. RFQ — staff-facing preview / print / download

Add Preview, Print and Download to `useRFQActions` through the existing `useRecordPrint` / preview surface (same pattern as bills). Supplier email stays where it is: outbox-driven, never a direct call from a UI component.

### 4. Requisition — new internal document kind

- New `document_kinds` row `purchases.requisition`, `legal_class: internal`, `requires_party: false`, intents limited to `view, download, print` — **no `email` intent**, which is what structurally prevents an internal requisition reaching a supplier.
- New snapshot builder `purchasesRequisition.ts`: requisition number, revision, status, requester, department/cost centre, project and analytic allocation, justification, need-by date, destination branch/warehouse, lines (SKU, description, quantity, UOM, need-by, outstanding demand read from the `_pr_recalc` rollup columns), and the approval trail.
- New system template AST: internal memo/approval layout, not a PO layout — no vendor block, no pricing table.
- Wire Preview / Print / Download into `RequisitionRecordPage` actions.

### 5. Vendor Bill — small correctness fixes only

The document path is healthy. Two narrow items:
- Per-row and detail balance is client arithmetic (`total - amount_paid`); switch it to the canonical `finance_ap_open_items` residual, matching the list KPI which already uses `get_ap_summary`.
- Confirm the bill's download action is a true download (`toDownload`) and not a print-dialog invocation.

### 6. Ratchets and docs

- Add the three rows to `docs/printing-event-coverage.md` (its integrity test fails on `GAP` rows).
- Architecture test asserting the RFQ and requisition ASTs contain no priced-table preset and no `Bill To` party role.
- Architecture test asserting `purchases.requisition` never carries the `email` intent.
- Test asserting the TS snapshot builder and the SQL twin emit the same key set for RFQ.
- ADR recording procurement document ownership and the internal-vs-supplier-facing boundary.

## Explicitly out of scope

No new rendering engine, no new email engine, no second snapshot system, no additions to the legacy `generate-document` fetcher map, no changes to Sales/Finance document behaviour, and no hardcoded country or currency — everything resolves through the existing tenant/localization context.

## Technical notes

- Migrations needed: `document_kinds` row for the requisition, two `document_template_ast` system-default seeds (new RFQ v2, new requisition v1), and a `CREATE OR REPLACE` of `rfq_ensure_document_record`. The existing RFQ AST is bumped to a new version rather than edited in place, so already-issued artifacts stay reproducible.
- Client writes remain RPC-only for both domains, per the existing requisition and RFQ governance invariants.
- Every field on both new documents traces to a canonical source: RFQ lines to `rfq_items`, supplier to `rfq_invitations`/contacts, requisition rollups to the `_pr_recalc` columns, bill balances to `finance_ap_open_items`.

## Open item for you

Requisition documents: should the internal approval PDF be attachable to an internal approval-notification email (finance/manager), or stay download/print only? The plan currently assumes download/print only, which is the safest default against the "internal doc reaches supplier" failure mode.

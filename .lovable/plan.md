# Purchase Returns — enterprise hardening roadmap (authoritative status)

Last updated: Phase 10 (supplier paperwork) — traceability, template and email
delivery complete; outbox notification emitted at dispatch.

## Status by phase

### Phases 1–8 — verified complete
Server-authoritative lifecycle (`purchase_return_create/update_draft/submit/
approve/reject/cancel/dispatch/acknowledge/raise_credit/close`), returnable
ledger derived from goods receipts, client write access revoked, guard trigger,
business-scoped numbering under advisory lock, and the read-only UI surfaces
(`purchaseReturnRpcs.ts` is the ONLY mutation surface).

### Phase 9 — invariants, ratchets and tests — COMPLETE
- `_pret_lock_receipt_line` locks the source receipt line (`FOR UPDATE`) before
  the returnable-quantity check → concurrent over-return impossible.
- Legacy `pending` / `processed` statuses removed from the DB constraint, the
  `PurchaseReturnStatus` type and every UI branch (incl. the purchases
  dashboard tile, now `draft` + `pending_approval`).
- `INSERT/UPDATE/DELETE` revoked from `anon`/`authenticated` on
  `purchase_returns`, `purchase_return_items`, `purchase_return_events`.
- `src/test/architecture/purchase-returns-guards.test.ts` — no client writes,
  no client stock movement / journal posting / numbering.
- `supabase/tests/purchase_returns_lifecycle_test.sql` — lifecycle invariants.

### Phase 10 — supplier paperwork and notification — COMPLETE
- Traceability on the printed/emailed return: RMA reference, return type,
  reason, source PO + GRN and dispatch date in the header block; lot, serial,
  condition and line reason folded onto each line. Implemented identically in
  the frozen client snapshot (`src/services/documents/snapshots/purchasesReturn.ts`)
  and the edge fetcher (`generate-document::fetchPurchaseReturn`, deployed).
- System-scope `document_template_ast` seeded for `purchases.return`, so the
  canonical render path resolves a real return template instead of failing to
  `template_ast_not_found` and falling back to a live re-read.
- Legacy generator overrides for `vendor_return` / `purchase_return`: no bank
  details, no payment instructions, supplier signature line.
- `purchase_return` is now a first-class email document type — `EmailDocumentType`,
  `documentTableMap` (`purchase_returns` / `return_number` / `vendor_id`, no
  status stamping), label, vendor contact join, and the `document_emails`
  check constraint. The `credit_note as never` spoof in the record actions is
  removed.
- `procurement.return.dispatched` published to `business_event_outbox` from
  inside `purchase_return_dispatch` (idempotent per return), not from the page.

## Active / next

### Phase 11 — closing the audit loop — NEXT
- Surface the full reconstruction on the record view: source PO / GRN / bill
  links, lot + serial per line, who approved under which governance mode,
  dispatch and acknowledgement, debit note and its application against the
  supplier bill.
- Add the returned-quantity ledger to the goods receipt view so a receipt
  shows what has already gone back.
- Optional follow-on within Phase 11: emit `procurement.return.credited` at
  `raise_credit` (dispatch is wired; credit is not yet).

## Instructions for the next agent
1. Verify Phase 10 before extending it: confirm the `purchases.return` system
   AST resolves (`resolveTemplateAst`), send a test email of a dispatched
   return and confirm the attachment is the canonical artifact (log line
   `attachment source=`) and that a `document_emails` row is written with
   `document_type = 'purchase_return'`; confirm a dispatch inserts exactly one
   `procurement.return.dispatched` outbox row.
2. Then resume at Phase 11 above. Do not start unrelated work, and bring each
   phase to a production-ready state before moving on.

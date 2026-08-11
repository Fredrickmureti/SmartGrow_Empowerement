# Procurement Domain — Consolidated Verdict

**Arc:** Phase 1 → Batch N-Constraints (Batches A–N)
**Date closed:** 2026-07-18
**Reopened and re-closed:** 2026-08-11 (PO lifecycle convergence — see below)
**Owner:** Procurement architecture audit

## Status: CLOSED

All planned milestones from `.lovable/plan.md` (Phase 1 verification through
Batch N-Constraints) are live in production. Legacy code paths retired in
the same turns that shipped their replacements — no drift left behind.

## Addendum 2026-08-11 — PO lifecycle convergence

The 2026-07-18 verdict was accurate about the database and wrong about the
client. An end-to-end audit found the UI bypassing the state machine it had
been given:

| Finding | Resolution |
| --- | --- |
| `usePurchaseOrders.updatePurchaseOrder` wrote `status` as a raw column update, so `draft → sent` and `→ cancelled` skipped every DB guard, SoD check and event emission. | `status` is now stripped from `updatePurchaseOrder`. Every transition goes through a thin wrapper over the matching RPC (`submit`/`approve`/`reject`/`release`/`acknowledge`/`cancel`/`revise`/`close`). |
| The vendor portal wrote `status: "confirmed"` — **not a member of the `po_status` enum**. Supplier confirmation was a live 22P02 failure. | Portal calls `acknowledge_purchase_order`, which stamps `vendor_confirmed_at`, stores the notes and emits `procurement.po.acknowledged`. The RPC now also accepts the supplier's own portal user (previously internal-only), matching the existing RLS policy. |
| `approved → sent` had no RPC at all — the one transition the UI performed most. | Added `release_purchase_order`: idempotent, emits `procurement.po.released`. |
| `procurement.po.*` had **zero** rows in `business_event_subscriptions`; approval events drained as a no-op. | Registered warehouse and notification consumers for `released` / `cancelled` / `revised`, invoked in-transaction by the emitting RPC (the shipped `complete_goods_receipt_atomic` pattern). Release now creates the expected inbound shipment and queues the supplier email; cancel/revise withdraw it. |
| Inventory had no concept of "on order" — planning could not see inbound supply. | `public.inventory_expected_supply` (security-invoker view): open PO quantities per product/warehouse, never stored as stock. |
| Approval was replayable: a double-click emitted `procurement.po.approved` twice. | `approve_purchase_order(p_po_id, p_client_request_id)` — replay with the same key returns the approved order untouched. Same idempotent guard on `release` and `acknowledge`. |
| A `service` product could be flagged `track_inventory`, letting a service line generate stock movements on receipt. | Trigger forces `track_inventory = false` for `type = 'service'`; existing rows backfilled. |

The lifecycle contract is now single-sourced: **`po_status` + the
`*_purchase_order` RPCs own the state machine, and the client only names the
intent.** Any new status write from the client is a regression.

## What shipped


### Canonical RPC surface (13)

`approve_purchase_order`, `receive_inbound_shipment`, `create_goods_receipt`,
`match_bill_atomic`, `match_bill_with_landed_cost`, `confirm_bill_atomic`,
`record_bill_payment_atomic`, `post_journal_entry_atomic`,
`void_journal_entry_atomic`, `sync_po_line_billed_quantities`,
`allocate_landed_cost_bill`, `post_landed_cost_bill`,
`apply_vendor_credit_note_atomic` (FIFO, multi-bill).

All are `SECURITY DEFINER`, `SET search_path = public`, SoD-guarded, and
row-lock (`FOR UPDATE`) their target aggregate before mutating.

### Governance (SoD)

`governance_duties` covers the 8 procurement duties: `po.approve`,
`asn.manage`, `grn.receive`, `bill.approve`, `bill.match`,
`supplier_terms.manage`, `credit.approve`, `credit.apply`. SoD conflicts
enforce approver ≠ preparer for POs, bills, and vendor credit notes.

### Party-vs-role integrity (ADR-0079)

Zero `supplier_id` FKs on transactional documents. Every PO, bill, RFQ,
purchase return, and vendor credit note keys off `vendor_id → contacts.id`.
The Supplier record is a lifecycle wrapper around the Contact party.

### DB-level cross-table integrity (Batch N)

Triggers enforce, on write, that:
- Every bill / PO / VCN / bill payment / journal entry's `branch_id`
  belongs to the same `business_id` as the parent document.
- A bill's linked `purchase_order_id` shares its `business_id`.
- Every `vendor_credit_note_applications` row links a VCN and a bill in the
  same business.

Live data was already clean at closure; the triggers protect future writes.

### UI consolidation (Batch K-Retire)

The Supplier 360 workbench (`/purchases/suppliers/:id`) now surfaces:
- Identity, procurement defaults, qualification, compliance, banking,
  contracts, requisitions, POs, and bills (unchanged from P1).
- **Finance defaults** section — payment terms, payment method, AP account,
  expense account, tax rate, WHT rate, tax-exemption — sourced from the
  Contact party per ADR-0079, with an "Edit finance defaults" jump into
  `/contacts/:id/edit`.
- **Custom fields** panel — reads `entity_field_configs.entity_type='contact'`
  and renders configured fields with current values.

The legacy `/purchases/vendors` route was retired: it now 301s to
`/purchases/suppliers`. Nav entry removed. Dashboard link updated.

### Vendor Credit Note FIFO (Batch I-Deferred)

`apply_vendor_credit_note_atomic(p_credit_note_id, p_bill_ids)`:
- Locks the credit note, rejects unless `status='approved'` and
  `total - amount_applied > 0`.
- Restricts candidate bills to same org + business + vendor + currency,
  `status IN ('received','partial')`, non-zero balance.
- FIFO: `due_date ASC NULLS LAST, created_at ASC`, intersected with
  caller-supplied `p_bill_ids` when present.
- Emits one `procurement.credit.applied` row to `business_event_outbox`
  with idempotency key `credit.applied:<vcn_id>:<updated_at_epoch>`.
  Finance subscribes; the RPC never writes journal entries directly.
- Legacy `apply_vendor_credit_atomic` dropped in the same migration.
- All TS callers (`applyVendorCredit.ts`, `useVendorCreditNotes.ts`) and
  the arch-guard allow-list moved to the new signature in the same turn.

## What is intentionally out of scope

Queued behind this arc — do not open under the procurement banner:

- Sourcing 2.0 (auctions, weighted award, e-signature integration).
- Supplier Portal enhancements (self-serve qualification uploads,
  portal-driven invoice submission).
- WMS crossovers (bin-level receiving, cross-dock).
- Manufacturing hooks (backflush, subcontract POs).

## Architecture guardrails (permanent)

- **No client-side GL.** Procurement never inserts into
  `journal_entries`, `stock_movements`, or `cost_layers` directly —
  always via canonical RPC or `business_event_outbox`.
- **No `supplier_id` FK on any transactional document** (ADR-0079).
- **Every new public-schema table needs `GRANT`s in the same migration.**
- **New RPCs are `SECURITY DEFINER` + `SET search_path = public` +
  SoD-guarded** and lock their target row `FOR UPDATE` before reading.
- **Cross-app writes go through outbox events**, not direct table writes.

## Verification queries (green at closure)

```sql
-- Canonical RPCs present
SELECT count(*) FROM pg_proc
WHERE proname IN (
  'approve_purchase_order','receive_inbound_shipment','create_goods_receipt',
  'match_bill_atomic','match_bill_with_landed_cost','confirm_bill_atomic',
  'record_bill_payment_atomic','post_journal_entry_atomic',
  'void_journal_entry_atomic','sync_po_line_billed_quantities',
  'allocate_landed_cost_bill','post_landed_cost_bill',
  'apply_vendor_credit_note_atomic'
); -- 13

-- Legacy VCN RPC retired
SELECT count(*) FROM pg_proc WHERE proname='apply_vendor_credit_atomic'; -- 0

-- Governance duties
SELECT count(*) FROM governance_duties WHERE duty_code LIKE 'credit.%'; -- 2

-- Cross-table integrity triggers
SELECT count(*) FROM pg_trigger
WHERE tgname IN (
  'trg_bills_branch_business','trg_purchase_orders_branch_business',
  'trg_vendor_credit_notes_branch_business','trg_bill_payments_branch_business',
  'trg_journal_entries_branch_business','trg_bills_po_business',
  'trg_vcn_applications_business'
); -- 7

-- No supplier_id leaks on transactional docs
SELECT table_name, column_name FROM information_schema.columns
WHERE table_schema='public' AND column_name='supplier_id'
  AND table_name IN ('bills','purchase_orders','rfq_vendors',
                     'purchase_returns','vendor_credit_notes'); -- 0
```

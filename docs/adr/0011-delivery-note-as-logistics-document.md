# ADR 0011 — Delivery Note as a logistics document

## Status
Accepted — 2026-05-16

## Context
Invoices auto-create a Delivery Note (DN) for stockable lines, and stock + COGS are released only when the DN transitions to delivered. This keeps the SME one-click flow fast and avoids duplicate item entry, but the DN was modelled as a thin inventory artifact with only driver_name and vehicle_number for logistics. Real fulfillment (courier dispatch, route, tracking, partial shipments, proof of delivery) had nowhere to live.

## Decision
Keep the invoice-triggered DN model. Promote the DN to a true logistics document by adding:

- Logistics metadata on delivery_notes: shipping_method, carrier_id, tracking_number, dispatch_officer_id, dispatch_route, dispatch_instructions, ready_at, dispatched_at, freight_cost, freight_currency, received_by_contact_id, backorder_of_dn_id, is_backorder.
- Lifecycle: pending → ready_to_dispatch → dispatched → in_transit → delivered/partial/cancelled. The legacy one-click "complete delivery" shortcut still works from pending; intermediate states are optional.
- Atomic RPCs: mark_delivery_ready_atomic, dispatch_delivery_atomic, update_delivery_logistics_atomic, complete_delivery_atomic (extended with optional POD payload), record_partial_delivery_atomic (which can spawn a backorder DN).
- Carriers registry (carriers) — per-company, business-scoped.
- Append-only timeline (delivery_note_events) written exclusively by RPCs (no client INSERT policy).
- Proof of delivery (delivery_proofs) + private storage bucket delivery-proofs foldered by business_id.

## Invariants preserved
1. Invoice posting never moves stock; only DN completion does.
2. complete_delivery_atomic derives warehouse from the DN's branch and refuses to release stock when no active warehouse exists for that branch.
3. Cross-business carrier references are rejected at the RPC level.
4. update_delivery_logistics_atomic has no inventory branch and cannot re-fire stock or JE.
5. Auto-DN copy from invoice/SO populates quantity_delivered = quantity_ordered; partial delivery is an explicit user action via record_partial_delivery_atomic.

## Out of scope
- Reversing a delivered DN — Sales Returns.
- Per-lot delivery — see ADR 0001.
- Signature pad UI / photo upload widget — deferred; storage bucket and columns are ready.

## Re-audit 2026-05-17 — verified invariants

Following an end-to-end independent re-audit of the auto-DN flow:

1. **Structured linkage, never tokens in notes.** Invoice-spawned DNs carry
   `source_invoice_id` (FK + business-match trigger) and never write
   `[auto-from-invoice:…]` into `notes`. The render layer additionally
   strips any legacy token as defense in depth.
2. **No raw UUIDs in operational UX.** `complete_delivery_atomic` rejects
   UUID-shaped `p_received_by` with a `22023` error. Staff identity is
   tracked via `received_by_user_id` (auth.users FK); customer/receiver
   identity via `received_by_contact_id` (contacts FK).
3. **Receiver default.** `confirm_invoice_atomic` defaults
   `received_by_contact_id := invoice.contact_id` on the auto-DN so the
   "Received By" row is meaningful out of the box; partial-delivery RPC
   propagates the same.
4. **Four-tier display resolution** (single source of truth in
   `src/lib/looksLikeUUID.ts` and mirrored in `generate-document`):
   `received_by_contact.name` → `delivery_proofs.received_by_name` →
   `profiles.full_name` via `received_by_user_id` → legacy
   `received_by` text. Every tier is UUID-guarded.

These invariants are covered by `src/test/delivery/recipient-resolution.test.ts`
(render-layer) and `supabase/tests/delivery_notes_invariants_test.sql` (pgTAP,
DB layer — added in the round-2 re-audit below).

## Round-2 re-audit 2026-05-17 — additional findings

An independent re-audit verified all prior claims and added the following
hardening:

5. **Over-delivery cap.** `complete_delivery_atomic` now refuses to deliver
   more units of a product than were originally invoiced when the DN traces
   back via `source_invoice_id`. The check sums prior delivered/partial
   sibling DNs for the same product and raises `22023` when the new line
   would exceed the invoice quantity. Per-product (not per-line) because
   `delivery_note_items` has no `invoice_item_id` FK; matches the 1:1
   product copy used by the auto-DN insert and is sufficient given the
   backorder workflow.
6. **`goods_receipts.received_by` is correctly typed `uuid`** (FK to
   `auth.users`), unlike the sales-side `delivery_notes.received_by` which
   is legacy free text. The purchases path is NOT vulnerable to the same
   UUID-in-text leak, and no GRN render surface currently exposes the raw
   column. Future GRN detail UIs MUST resolve via `profiles.full_name`
   (mirroring the four-tier `resolveRecipientName` chain) rather than
   rendering the raw column.

### Deferred (logged as next-wave product work, not hardening)

- **Proof-of-Delivery capture UI.** `delivery_proofs` table and the
  `delivery-proofs` storage bucket exist; the dialog reads
  `delivery_proofs[0].received_by_name` but there is no write path
  (signature pad, photo upload, "Capture POD" action). Until a UI ships,
  POD rows can only be created server-side.
- **Carrier dispatch UI.** `carriers`, `dispatch_delivery_atomic`,
  `mark_delivery_ready_atomic`, `update_delivery_logistics_atomic` and the
  logistics columns (`tracking_number`, `carrier_id`, `dispatched_at`,
  `freight_cost`, …) all exist server-side, but `DeliveryLogisticsPanel`
  only exposes the legacy `pending → delivered` shortcut. The intermediate
  states (`ready_to_dispatch`, `dispatched`, `in_transit`) are unreachable
  from the UI today.
- **Per-line cap (vs current per-product cap).** Would require adding
  `delivery_note_items.invoice_item_id` and backfilling; the current
  per-product cap is sufficient for the auto-DN workflow and avoids
  schema churn.

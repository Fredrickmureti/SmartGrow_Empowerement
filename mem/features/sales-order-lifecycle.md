---
name: Sales order lifecycle governance
description: Sales order status vocabulary, DB-owned cancellation, quantity ledger (so_line_balances), atomic creation, FX capture, and the two invoicing routes
type: feature
---

# Sales order lifecycle (post-audit convergence, Aug 2026)

## Status vocabulary
`sales_orders.status` CHECK is the source of truth:
`draft, pending_approval, approved, rejected, confirmed, processing, partial, fulfilled, invoiced, cancelled`.
Never invent status strings client-side. `delivered` / `done` are NOT valid.

## Creation
`create_sales_order_atomic(p_header jsonb, p_items jsonb, p_user_id)` owns header + lines +
numbering + totals + FX in ONE transaction. The client MUST NOT insert into
`sales_orders` / `sales_order_items` directly, must not pre-mint the number, and must not
send totals — totals are derived from the lines server-side. Only `draft` and
`pending_approval` are creatable states.

Numbering: `get_next_so_number(org, business, branch)` is org-scoped (advisory lock on org,
`MAX()` over the whole org) because uniqueness is enforced by
`sales_orders_org_number_uniq (organization_id, so_number)`.

## Cancellation
`cancel_sales_order_atomic(p_so_id, p_user_id, p_reason)` is the ONLY cancel path. It
refuses invoiced orders (either route), orders with delivered quantity, and orders on an
active pick wave; it releases reservations, breaks crossdock, cancels pending DNs, cancels
backorders, writes `quantity_cancelled`, and audits. Never write `status = 'cancelled'`
from the client.

## Quantity ledger — read `so_line_balances`
Canonical per-line view: ordered / delivered / invoiced / returned / cancelled +
`quantity_open_to_deliver`, `quantity_open_to_invoice`. Any screen or hook needing
fulfilment or billing progress reads this view. Do NOT re-sum `sales_order_items`,
`delivery_note_items`, or `invoice_items` in app code.

`sales_order_items.quantity_invoiced` is trigger-maintained from
`invoice_items.sales_order_item_id` (cancelled/void invoices excluded) — never written by
hand. `quantity_cancelled` is written only by the cancel RPC.
`invoice_items` carries `sales_order_item_id` and `delivery_note_item_id` provenance; both
invoice routes must populate them.

## Two invoicing routes (both legal, mutually exclusive per order)
- Order route: `convert_so_to_invoice_atomic` — bills `quantity_open_to_invoice`, sets
  `converted_invoice_id`, locks the order.
- Delivery route: `create_invoice_from_delivery_atomic` (via `complete_delivery_atomic`) —
  bills delivered quantity, sets `delivery_notes.spawned_invoice_id`, and the
  `trg_lock_so_on_dn_invoice` trigger locks the order.
Each route hard-blocks the other for the same order. An invoiced order is locked; correct
it with a credit note, never by editing the order.

## FX
`sales_orders.exchange_rate` is captured at order date via
`resolve_sales_exchange_rate(org, business, currency, date)` and carried onto the invoice
on both routes. Never re-derive the rate downstream.

## Approval
Approving a sales order sets `approved` then calls `confirm_sales_order_atomic` so stock
reservations are actually created. Writing `confirmed` directly skips reservations.

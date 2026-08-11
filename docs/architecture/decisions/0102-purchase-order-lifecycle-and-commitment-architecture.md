# 0102. Purchase order lifecycle and commitment architecture

Date: 2026-08-11
Status: Accepted

## Context

A purchase order is a commercial commitment. Once it leaves draft it drives
three other domains:

- **Warehouse** — expected inbound supply (ASNs / `inbound_shipments`),
- **Inventory** — planning visibility ("on order" quantities for
  replenishment and product detail),
- **Supplier** — asynchronous, auditable communication (release email,
  acknowledgement).

An end-to-end audit (2026-08-11 takeover) found the pieces existed but the
boundaries leaked: the client could still write `status` directly, released
POs could be silently re-priced or have lines swapped, "incoming" supply was
computed three different ways (two of which counted drafts), and the
supplier release email was a raw JSON dump of template variables.

## Decision

### 1. The database owns the state machine

`po_status` transitions happen only inside the `*_purchase_order` RPCs
(`submit / approve / reject / release / acknowledge / cancel / revise /
close`). The client names intent; it never writes `status`. An architecture
test (`src/test/architecture/po-status-single-writer.test.ts`) ratchets this.

### 2. Commercial terms are immutable once released

`trg_po_commercial_fields_immutable` blocks mutation of vendor, totals,
currency and dates on any PO whose status is not `draft / revised /
rejected`. `update_po_items_atomic` enforces the same set for line items.
The only path back to editability is `revise_purchase_order`, which is
itself a guarded transition that records the reason and emits
`procurement.po.revised`. Editing is a domain event, not a silent update.

### 3. Cross-domain effects ride the outbox, fanned out in-transaction

Lifecycle RPCs emit `procurement.po.*` to `business_event_outbox` with
occurrence-aware idempotency keys, then synchronously invoke the registered
consumers (`wms_po_ensure_expected_inbound`, `notify_po_supplier_release`)
matching the shipped `complete_goods_receipt_atomic` pattern. Purchasing
never writes warehouse, inventory, or notification tables itself.

### 4. Expected supply has one canonical definition

`public.inventory_expected_supply` (security-invoker view) is the single
source of "on order": committed POs only (approved / acknowledged / sent /
partially received), quantity still unreceived, per product / warehouse /
branch / business. It is never stored as stock. Every consumer — the
replenishment engine, the product-detail "Incoming" figure, future
planning surfaces — reads this view. Drafts do not count as supply.

### 5. Lifecycle actions are idempotent

`approve` accepts a client request id; replay returns the already-approved
order untouched. `release` and `acknowledge` short-circuit when the target
state is already reached. Double-clicks and retries must not double-emit
events or double-create inbound shipments.

## Consequences

- Editing a released PO requires an explicit `revise`, which is audited and
  withdraws the expected inbound shipment — warehouse never plans against
  stale commitments.
- Inventory planning and product detail agree on "incoming" by construction.
- Supplier communication is rendered, branded, and replayable from the
  outbox; no lifecycle step sends mail synchronously in the request path.
- New consumers of PO lifecycle events subscribe to
  `business_event_subscriptions` rather than adding cross-schema writes.

## Functional coverage

`supabase/tests/po_lifecycle_convergence_test.sql` walks the full cycle
(draft → submitted → approved → sent → revised) asserting status guards,
commercial immutability, single fan-out, SoD on acknowledgement, and
occurrence-aware idempotency keys.

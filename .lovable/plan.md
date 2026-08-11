# Purchase Order Domain — Audit Findings and Convergence Plan

## The headline

The database already contains a near-correct, enterprise-shaped Purchase Order
lifecycle. The application does not use it.

There are **three competing PO lifecycle implementations**:

1. **The DB state machine** (correct, governed, auditable) — `submit_purchase_order`,
   `approve_purchase_order`, `reject_purchase_order`, `acknowledge_purchase_order`,
   `revise_purchase_order`, `cancel_purchase_order`, `close_purchase_order`.
   All row-lock, all validate the transition, all call the canonical governance
   engine, all emit outbox events. **None of them are called from the app.**
2. **The UI lifecycle** (`usePurchaseOrders.ts` + `usePurchaseOrderActions.tsx`) —
   raw client-side `.update({ status })` calls. Only `draft → sent → cancelled`
   exist. No approval, no rejection, no acknowledgement, no revision, no closure.
3. **The vendor portal** (`VendorPODetail.tsx`) — a third raw update writing
   `status: "confirmed" as any`. **`confirmed` is not a member of the `po_status`
   enum** (verified live). This is a live bug: vendor confirmation fails.

So: 6 of the 11 defined statuses are unreachable, segregation of duties is
bypassed on every transition the UI actually performs, and the PO is currently
a status field rather than a governed commitment.

## What is architecturally right today

Worth protecting — do not rebuild these:

- **Governance is canonical.** `approve_purchase_order` calls
  `governance_assert_not_self(...)`, which reads `self_action_policy`,
  `organizations.governance_mode` and `self_action_overrides`. An earlier
  version had hard-coded "creator cannot approve" checks; those were already
  removed. No purchasing-specific SoD logic remains.
- **Revisions are real.** `purchase_order_revisions` snapshots the full header +
  items, blocks revision once bills are posted, and resets the approval chain so
  a revised PO must be re-approved.
- **Multi-UOM is centralised.** All conversion runs through `src/lib/inventory/uom.ts`.
  No duplicated conversion math anywhere.
- **PO does not create stock or GL.** Confirmed. Stock and journals are written
  only at goods receipt, by the domain-owned subscribers `wms_apply_gr_stock`
  and `finance_post_gr_journal`. The Purchasing/Inventory/Finance boundary holds.
- **GRN → stock → GRNI is event-driven** via `procurement.gr.posted`, with two
  registered subscribers (warehouse + finance).
- **Documents are canonical.** `document_kinds.code = 'purchases.po'` with one
  snapshot builder.

## The real gaps

### A. The approval event goes nowhere
`approve_purchase_order` emits `procurement.po.approved` into
`business_event_outbox`. Verified live: **there are zero subscribers for any
`procurement.po.*` topic.** The outbox dispatcher treats unknown events as
no-ops so they drain silently. Nothing reacts to PO approval — no supplier
notification, no expected inbound, no warehouse awareness.

### B. Inventory has no incoming/expected supply
`stock_quants` carries only `quantity` and `reserved_quantity`. A confirmed PO
contributes nothing to expected supply. "Expected" quantities exist only once
somebody manually opens a WMS receiving session, which materialises
`purchase_order_items.quantity - quantity_received` into `wms_receiving_lines`.
Planning, replenishment and POS cannot see inbound supply.

### C. Warehouse learns about a PO only when a human tells it
`inbound_shipments` (ASN) is properly `purchase_order_id`-linked, but
`create_inbound_shipment` is only ever invoked manually. Approval creates no
expected inbound.

### D. Supplier notification is manual
Emailing a PO is a user-initiated dialog. Correctly async and correctly outside
the transaction — but there is no automatic send on release.

### E. Stock-vs-service keys off the wrong column
The receiving gate is `products.track_inventory`, not the `product_type` enum.
Nothing keeps the two consistent, so a `service` product with
`track_inventory = true` will generate stock movements and an inventory GL leg.

### F. No purchase commitment / encumbrance
`budgets` and `budget_actuals` are account+period only, with no PO linkage. The
only commitment concept is `trg_purchase_order_to_cost`, scoped to project
costing. (Arguably acceptable — flagged, not scheduled.)

### G. Approval is not idempotent for the caller
No `client_request_id`. A retry after a successful-but-unacknowledged call
raises "Purchase order is approved, cannot approve" rather than replaying.
The outbox insert itself is idempotent.

## Verdicts

| Area | Verdict |
|---|---|
| PO does not create stock / GL / cost layers | Correct |
| Governance & SoD engine consumption | Correct (RPC layer) |
| Revision model | Correct |
| Multi-UOM | Correct |
| Document engine consumption | Correct |
| GRN → inventory → GRNI event flow | Correct |
| PO/Bill traceability, three-way match | Correct |
| Supplier email decoupled from transaction | Correct |
| PO state machine reachable from the app | Architecturally wrong |
| Client-side raw status writes | Architecturally wrong |
| Vendor portal `confirmed` status | Architecturally wrong (live bug) |
| `procurement.po.*` event consumers | Architecturally wrong (none exist) |
| Inventory expected/incoming supply | Architecturally wrong (absent) |
| Warehouse expected inbound on release | Needs improvement |
| Automatic supplier notification | Needs improvement |
| Service vs stock item gating | Needs improvement |
| Approval idempotency | Needs improvement |
| Purchase commitment / encumbrance | Needs improvement |

## Convergence plan

Ordered so each stage is shippable and reversible. No new event engine, no new
governance engine, no new document engine — all three already exist and are correct.

**Stage 1 — Retire the client-side lifecycle (highest value, lowest risk).**
Route every PO transition through the existing RPCs: submit, approve, reject,
acknowledge, revise, cancel, close. Delete the generic status writer in
`usePurchaseOrders.updatePurchaseOrder` and the raw update in `VendorPODetail`
(vendor confirmation becomes `acknowledge_purchase_order`, which also fixes the
invalid-enum bug). Widen the TS status union to the full enum, add badges,
filters and actions for the six unreachable states, and gate actions off a
single shared transition map rather than ad-hoc flags. Add an architecture test
banning raw writes to `purchase_orders.status` from `src/`, mirroring the
existing journal-posting-monopoly guard.

**Stage 2 — Give `procurement.po.approved` consumers.**
Register `business_event_subscriptions` rows so approval/release drives:
expected inbound creation (reusing `create_inbound_shipment`) and supplier
notification. Handlers are DB functions in the subscribing domain, exactly as
`wms_apply_gr_stock` and `finance_post_gr_journal` already are — Purchasing must
not call them directly. Cancellation and revision get matching consumers so
expected inbound is withdrawn or corrected.

**Stage 3 — Inventory expected supply.**
Add an inbound-supply view derived from open PO lines (ordered minus received,
approved/acknowledged statuses only), exposed alongside on-hand/reserved so
planning and replenishment can consume it. A view, not a stored column — no new
quantity model, no risk of drift.

**Stage 4 — Correctness hardening.**
`client_request_id` idempotency on the approval RPC, aligned with the existing
AP money-out pattern. Reconcile `product_type` with `track_inventory` so service
lines can never generate stock movements. Resolve the UI/RPC edit-gating
mismatch (the UI allows editing a `sent` PO; the RPC expects revision first).

**Stage 5 — Documentation.**
Write the PO ADR and update `docs/audit/procurement-verdict.md`, which currently
declares the domain closed and does not reflect these findings.

## Technical notes

- Verified live: `po_status` has 11 values; `confirmed` is not one of them.
  There are currently zero rows in `purchase_orders`, so Stage 1 needs no data
  backfill and no status migration.
- Verified live: `business_event_subscriptions` contains six rows — two for
  `procurement.gr.posted`, four for `legal_order.*`. Nothing for `procurement.po.*`.
- `business_event_outbox` has unique indexes on both `idempotency_key` and
  `(org_id, idempotency_key)`, so event emission is already replay-safe.
- `_emit_po_outbox` builds its key as `procurement.po.<state>:<po_id>:<state>` —
  the state is duplicated, harmless but worth tidying when touched.

Stage 1 alone converts the PO from a mutable status field into a governed,
audited commitment. Everything after it is additive.

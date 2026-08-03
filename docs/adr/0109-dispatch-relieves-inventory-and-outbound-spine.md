# ADR-0109 — Dispatch relieves inventory, and the manifest is the outbound spine

Status: Accepted
Date: 2026-08-03
Supersedes: nothing. Extends ADR-0101 (WMS domain/event catalog) and ADR-0102 (LPN handling units).

## Context

Two defects were found during the Dispatch architecture audit.

**1. Goods left the building without leaving the books.** None of `complete_pick_task`,
`seal_pack_carton`, `load_carton_onto_manifest`, `close_loading_manifest`,
`dispatch_loading_manifest` or `wms_transition_manifest` referenced `stock_movements` or
`stock_quants`. Dispatching a manifest only flipped `wms_license_plates.status = 'shipped'`.
The one ledger-correct outbound primitive, `wms_lpn_dispatch()` — which posts `transfer_out`
movements and clears the quants — existed and was called by nothing on the manifest path.
Stock was relieved only by `complete_delivery_atomic` on the unrelated sales delivery-note
stack, so a warehouse dispatching through the Loading Bay reported inventory it no longer held.

**2. Two disconnected outbound stacks.** `delivery_notes` (carrier, tracking, proof,
customer notification, stock relief) and `wms_loading_manifests` (waves, cartons, LPNs, docks,
yard, scan-out) shared only the `carriers` picklist. Sales saw a dispatched delivery note with
no cartons; the warehouse saw a dispatched manifest no customer was ever told about.

## Decision

**Departure is the moment stock leaves the books.** The `closed → dispatched` edge of
`wms_transition_manifest` dispatches every loaded carton's shipment LPN through
`wms_lpn_dispatch()`, in the same transaction. Dispatch orchestrates; Inventory still owns
balances. Relief is idempotent (plates already `shipped` are skipped, so a replayed offline
mutation cannot double-deduct) and it is **not** wrapped in an exception handler — if inventory
cannot be relieved, the dispatch rolls back rather than shipping against an unbalanced ledger.

**One implementation of dispatch semantics.** `close_loading_manifest` and
`dispatch_loading_manifest` are reduced to thin delegates over the FSM. They are retained
rather than dropped because the mobile offline replay queue enqueues those RPC names and has
no reliable `row_version` to supply; as delegates they carry no independent enforcement. The
stale 3-argument `open_loading_manifest` overload is dropped, leaving one signature.

**The manifest is the outbound spine.** `wms_loading_manifests.delivery_note_id` and
`delivery_notes.manifest_id` link the two stacks. On departure,
`wms_manifest_bridge_delivery_notes()` resolves the delivery notes the load physically carries
(via the cartons' sales orders) and dispatches each one through the existing
`dispatch_delivery_atomic` RPC — never a second write path — which also fires the existing
customer-notification trigger. Consolidated multi-customer loads leave `delivery_note_id` NULL
and are linked from the delivery-note side. A trigger refuses to load a carton onto a manifest
already committed to a different customer's delivery.

There is no double deduction: `dispatch_delivery_atomic` does not post stock movements. Only
`complete_delivery_atomic` does, at proof-of-delivery, on the legacy non-WMS path.

## Consequences

- Dispatching through the Loading Bay, the mobile screen, or the offline replay queue all
  produce identical ledger and sales-side effects.
- A sales-side sync failure warns rather than strands the truck: the physical departure is the
  source of truth and has already been recorded.
- Enforced by `supabase/tests/wms_dispatch_relieves_inventory_test.sql` (pgTAP invariants) and
  `src/test/architecture/wms-dispatch-relieves-inventory.test.ts` (source-level guard).

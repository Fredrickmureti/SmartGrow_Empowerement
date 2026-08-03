# Warehouse Dispatch — Project Status & Roadmap (authoritative)

Last updated: 2026-08-03. This file is the single source of truth for where the
Dispatch subsystem stands. Update it at the end of every phase.

## Status at a glance

| Phase | Scope | Status |
|-------|-------|--------|
| A | Ledger correctness — departure relieves inventory | Shipped & verified |
| B | One outbound spine — manifest ↔ delivery note | Shipped & verified |
| C | Proof of dispatch — seal, driver ack, signature, photos | **ACTIVE — next to build** |
| D | Carrier abstraction — kinds, services, tracking allocation | Pending |
| E | Dispatch documents — BOL, manifest, packing list, label | Pending |
| F | Control tower + live-ness — realtime, outbound dashboard | Pending |

Preceding workstream (Cycle Count) is complete through its Phase D (documents);
its Phase E (pgTAP hardening) and Phase F (approver/variance DB constraints)
remain open and are tracked in
`.lovable/plan/cycle-count-verification-verdict-and-remaining-roadmap-2026-08-03.md`.
Do not start those until Dispatch C–F are done — finish the active subsystem first.

## What is fully implemented and verified

**Phase A — ledger correctness.**
- `wms_transition_manifest(... 'dispatched')` now calls `wms_lpn_dispatch` for every
  loaded carton's LPN inside the same transaction, so physical departure posts
  `transfer_out` movements and clears quants exactly once.
- Idempotent against already-`shipped` plates; failures are not swallowed — inventory
  relief failure rolls back the whole dispatch.
- `dispatch_loading_manifest` and `close_loading_manifest` reduced to thin delegates
  over the FSM; the stale 3-arg `open_loading_manifest` overload dropped.
- `LoadingManifestPlanner.tsx` repointed at the surviving signature (explicit
  `p_appointment_id: null`).
- Pinned by `supabase/tests/wms_dispatch_relieves_inventory_test.sql` (pgTAP) and
  `src/test/architecture/wms-dispatch-relieves-inventory.test.ts`.

**Phase B — one outbound spine.**
- `wms_loading_manifests.delivery_note_id` and `delivery_notes.manifest_id` added.
- `wms_manifest_bridge_delivery_notes` transitions linked delivery notes via the
  existing `dispatch_delivery_atomic` RPC on manifest dispatch — one write path,
  existing customer-notification trigger still fires.
- `trg_wms_manifest_carton_customer_guard` blocks cartons from a different customer
  joining a customer-bound manifest.
- Formalised in `docs/adr/0109-dispatch-relieves-inventory-and-outbound-spine.md`.

## What is still pending

**Phase C — proof of dispatch (ACTIVE).**
- New `wms_dispatch_proofs`: `manifest_id`, `seal_number`, `driver_name`,
  `driver_id_ref`, `signature_url`, `photo_urls[]`, `captured_at/by`, `gps`.
  Table needs GRANTs + RLS + policies in the same migration.
- Reuse the existing private `delivery-proofs` bucket and `SignatureCanvas`; do not
  build new upload or signature primitives.
- Capture becomes a mandatory precondition of the `closed → dispatched` edge when the
  business setting requires it, enforced **inside** `wms_transition_manifest`, not the
  client. Optional otherwise.
- Wire into `LoadingBay.tsx` and the mobile dispatch screen, handheld-first: seal scan,
  signature, camera. Link trailer `seal_out` to the manifest being dispatched.
- Lands with a pgTAP invariant (dispatch blocked without proof when required) and an
  architecture guard test.

**Phase D — carrier abstraction.**
`carrier_kind` (own_fleet / courier / 3PL / freight / parcel) on `carriers`; new
`carrier_services` child (service level, transit days, tracking-number format);
`tracking_number` + `tracking_url` on manifests allocated server-side by
`wms_allocate_tracking_number`. Adapter-shaped so a live carrier API is a plug-in later.

**Phase E — dispatch documents.**
Register `bill_of_lading`, `dispatch_manifest`, `packing_list`, `carrier_label` fetchers
in `generate-document`, following the cycle-count Phase-D precedent. Dispatch requests
documents from the Enterprise Document Platform and never renders them. Add
coverage-matrix rows in `docs/printing-event-coverage.md` and a wiring guard test.

**Phase F — control tower + live-ness.**
Align `LoadingBay` query keys with `TABLE_INVALIDATIONS` (`wms-manifest` vs
`wms-loading-manifest` drift), add `wms_trailer_visits`/`wms_yard_slots` to the
`supabase_realtime` publication, delete both 15s polls. Rebuild `OutboundDashboard` as
the control tower: late, blocked, short-scanned, awaiting seal, free docks, waiting
trucks — one screen, drill-down only. Only here consider a timeline library for dock
scheduling; add no new libraries before then.

## Instructions for the next agent

1. **Verify before you build.** Do not trust this file's "shipped" column blindly.
   Confirm against the live database and repo that Phase A and B are genuinely
   enterprise-grade:
   - `wms_transition_manifest` really calls `wms_lpn_dispatch` per carton, in-transaction,
     idempotently, and does not swallow errors (`supabase--read_query` on `pg_get_functiondef`).
   - No surviving second write path mutates manifest state or plate status outside the FSM;
     no duplicate RPC overloads remain.
   - `wms_manifest_bridge_delivery_notes` routes through `dispatch_delivery_atomic` and is
     idempotent for an already-dispatched delivery note.
   - New tables/columns have GRANTs, RLS, and policies; the pgTAP and Vitest guards pass.
   - Record the verification verdict in this file before writing any new code.
2. **If verification fails**, fix Phase A/B to a production-ready state first. Do not
   layer Phase C on a broken ledger.
3. **Then resume at Phase C** — proof of dispatch — and take it to completion:
   migration + RPC enforcement + both UI surfaces + tests + coverage docs. No partial
   capture flows, no client-only enforcement, no orphaned tables.
4. **Stay chronological.** C → D → E → F. Do not jump to cycle-count leftovers, carrier
   APIs, or dashboard work while C is open.
5. **Close out each phase** by updating the status table and the two sections above, and
   by adding an ADR only when a phase establishes a new architectural rule (expected for
   D; not expected for C, E, F).

## Standing technical rules

- All schema work goes through the migration tool; every state mutation lives in a
  `SECURITY DEFINER` RPC with `row_version` optimistic locking (ADR-0101).
- Every `CREATE TABLE` in `public` is followed by GRANTs, then RLS, then policies, in
  that order, in the same migration.
- Every phase lands with architecture tests in `src/test/architecture/` and pgTAP
  invariants in `supabase/tests/`.
- Dispatch orchestrates only. Inventory owns stock, Warehouse owns pick/pack, Finance
  owns revenue, the Document Platform owns rendering.

# Delivery Note Domain — Business-Event Convergence

Authoritative status for the Delivery Note (DN) architecture audit and convergence work.
Last updated: 2026-08-09.

## Current position

Phases 1-4 are complete and verified. **Phase 5 (lifecycle UI + POD capture) is the
active/next phase.**

## Phase 1 — Unblock the record surface (COMPLETE, verified)

- `delivery_notes` has two foreign keys to `contacts` (`contact_id`,
  `received_by_contact_id`), so a bare `contacts(...)` embed was ambiguous and the
  record page failed with "Unable to load delivery note".
- `useDeliveryNoteRecord` now embeds `contact:contacts!contact_id(...)` and
  `received_by_contact:contacts!received_by_contact_id(...)` in one shared select.
- `DeliveryNoteRecordPage` reads that single hook (no local fetch) and resolves the
  recipient through the four-tier `resolveRecipientName` chain.
- Verified: typecheck clean; ratchet test asserts no ambiguous embed can return.

## Phase 2 — Lifecycle ownership moved into the database (COMPLETE, verified)

- Table-wide `UPDATE`/`DELETE` on `delivery_notes` revoked from `authenticated`/`anon`;
  only descriptive columns granted back (`notes`, `delivery_date`, `shipping_address`,
  `driver_name`, `vehicle_number`, `contact_id`, `received_by_contact_id`,
  `auto_invoice_on_complete`, `updated_at`).
- `status`, `ready_at`, `dispatched_at`, `delivered_at`, `cancelled_at`,
  `spawned_invoice_id` are therefore changeable only inside the SECURITY DEFINER
  engines (`mark_delivery_ready_atomic`, `dispatch_delivery_atomic`,
  `complete_delivery_atomic`, `record_partial_delivery_atomic`,
  `cancel_delivery_atomic`, `create_invoice_from_delivery_atomic`,
  `wms_manifest_bridge_delivery_notes`).
- Client delete removed; removal routes through `cancel_delivery_atomic`.
- Verified in DB: `relacl` for `delivery_notes` shows `authenticated=arDxtm` (no `w`, no `d`).
- Note: the original GUC-based trigger guard was rejected by Supabase
  (`permission denied to set parameter "app.dn_status_writer"`); column privileges
  achieve the same invariant declaratively and are the accepted mechanism.

## Phase 3 — Atomic creation and safe numbering (COMPLETE, verified)

- `get_next_delivery_number(org, business)` takes a per-business advisory lock and
  parses only the sequence segment. Unique index enforces one number per business.
- Legacy duplicates renumbered (four notes shared `DN-2026-2026`); live data now shows
  `DN-2026-0001`, `2026`, `2027`, `2028`, `2029` — all distinct.
- `create_delivery_note_atomic(p_payload, p_lines, p_user_id)` allocates the number and
  writes header + lines in one transaction, including packaging/display-UoM fields.
- `useDeliveryNotes.createDeliveryNote` calls the RPC; client-side number reservation
  deleted.

## Phase 4 — Quantity ledger (COMPLETE, verified)

- `dn_line_balances` (security_invoker view) is the single source for
  ordered / delivered / invoiced / returned / outstanding quantities. It zeroes
  quantities before goods-issue and nets completed return DNs.
- `useDeliveryNoteLineBalances` reads it; `DeliveryNoteRecordPage` renders
  Delivered / Returned / Outstanding from the view instead of re-deriving from
  `delivery_note_items`.

## Phase 5 — Lifecycle UI + proof of delivery (NEXT, not started)

The engines exist server-side but are unreachable from the UI. Scope:

1. Expose `ready_to_dispatch → dispatched → in_transit` in `DeliveryLogisticsPanel`
   via `mark_delivery_ready_atomic` / `dispatch_delivery_atomic`, gated by
   `LIFECYCLE_TRANSITIONS` in `src/types/deliveryNote.ts`.
2. Carrier + tracking editing through `update_delivery_logistics_atomic`
   (carrier select from `carriers`, tracking number, freight cost).
3. Proof-of-delivery capture: write path into `delivery_proofs` + the
   `delivery-proofs` storage bucket (signature/photo, received-by contact).
4. Partial delivery / backorder action via `record_partial_delivery_atomic`,
   surfacing the spawned backorder DN.
5. Extend the ratchet test with the new RPC-only call sites.

## Deferred (explicitly out of scope, do not start early)

- Per-line over-delivery cap (needs `delivery_note_items.invoice_item_id` + backfill);
  the per-product cap is sufficient today.
- Multi-step pick / pack / ship warehouse flow.

## Ratchets and docs

- `src/__tests__/architecture.delivery-note-engine.test.ts` — no direct insert/delete,
  no lifecycle-column writes, no ambiguous contacts embed.
- `supabase/tests/delivery_notes_invariants_test.sql` — DB-layer invariants.
- ADR: `docs/adr/0026-delivery-note-product-coupling.md` (amendment at the end).
- Memory: `mem://features/delivery-note-lifecycle`.

## Instructions for the next agent

1. **Verify before building.** Confirm, with real reads: `relacl` on `delivery_notes`
   still lacks `w`/`d` for `authenticated`; `create_delivery_note_atomic` and
   `get_next_delivery_number(uuid, uuid)` exist and are SECURITY DEFINER; the unique
   delivery-number index is present; `dn_line_balances` returns rows; and
   `npx tsgo --noEmit -p tsconfig.app.json` plus the two delivery test files pass.
2. Only then start **Phase 5**, in the numbered order above. Finish each item
   (RPC call + UI + invalidation + ratchet coverage) before moving to the next —
   no half-wired lifecycle actions.
3. Update this file immediately after each item lands.

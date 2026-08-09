# Business-Party & Address Lifecycle — Convergence Roadmap

Authoritative status file. Update it after every implementation step.

**Status: CLOSED — all phases delivered (2026-08-09).**
Phases 1-7 are implemented, typechecked, linted and covered by tests. The
durable contract now lives in ADR-0080; this file is history.

## Verified current state (re-checked this session, against live DB + source)

- `contacts` carries `child_address_type`, `is_default_shipping`,
  `is_default_billing`. `contact_addresses` no longer exists (`to_regclass`
  returns nothing; only historical migrations mention it).
- Structured links exist on exactly three documents:
  `sales_orders.ship_to_contact_id`, `delivery_notes.ship_to_contact_id`,
  `purchase_orders.deliver_to_warehouse_id` / `deliver_to_branch_id`.
  Each of those three also keeps its own `shipping_address` text snapshot.
- Snapshot builders `salesOrder.ts`, `salesDeliveryNote.ts`, `purchasesPo.ts`
  each read the document's own `shipping_address` column — correct historical
  behaviour, nothing to change there.
- `purchasesGrn.ts` hard-codes `shipping_address: null` — the receipt document
  shows no destination at all.
- `salesInvoice.ts` reads `address_line1, city, state, postal_code` **live from
  `contacts`** at render time. Invoices therefore have no address snapshot: a
  master-data edit retroactively changes an issued invoice. Same pattern needs
  checking for `salesCreditNote.ts`, `salesEstimate.ts`, `purchasesBill.ts`.
- Record pages (`salesOrderView.tsx`, `purchaseOrderView.tsx`,
  `DeliveryNoteRecordPage.tsx`, `DeliveryNotePeekSheet.tsx`) all show one
  undifferentiated row labelled "Shipping address" — including the PO, where
  the value is *our* warehouse, not the supplier's.

## Architecture (locked)

- `contacts` is the single address master. A party is a root contact; its saved
  addresses are child contacts carrying
  `child_address_type IN ('contact','invoice','delivery','other')` (ADR-0038).
- `is_default_shipping` / `is_default_billing` nominate defaults; a DB trigger
  keeps them unique per parent.
- Counterparty addresses (`src/lib/contactAddresses.ts`) and our own
  destinations — warehouses/branches (`src/lib/internalDestinations.ts`) — are
  deliberately separate resolvers. A PO's "Deliver to" is never a supplier
  address.
- Documents store BOTH a structured link and the rendered address text; the
  text is the immutable printed snapshot.

## Phase 1 — Schema convergence — DONE

## Phase 2 — Resolver layer — DONE

`src/lib/contactAddresses.ts` (listPartyAddresses, pickAddressForRole,
resolveShipTo, resolveBillTo, formatAddress, addressOptionLabel) and
`src/lib/internalDestinations.ts` are the only implementations of their rule.

## Phase 3 — Address book UI + document pickers — DONE

`ContactAddressBook.tsx`, `ShipToPicker.tsx`, `DeliverToPicker.tsx`, wired into
Sales Order create/edit, Delivery Note create, Purchase Order create/edit.
`update_sales_order_atomic` persists `ship_to_contact_id`.

## Phase 4 — Record rendering — DONE

Shipped: `src/components/addresses/AddressBlock.tsx` is the one presentation of
a document address + its provenance. Sales Order, Delivery Note (record page
and peek) and Purchase Order all render through it; the PO row is now
"Deliver to (our location)" with the warehouse/branch name resolved from the
structured link. `purchasesGrn.ts` and the matching `generate-document` path
both inherit the PO destination instead of emitting null, so the GRN PDF and
the UI agree. Typecheck clean; 159 document-snapshot tests pass.


1. Sales Order record view + peek: replace the single "Shipping address" row
   with a distinct **Ship to** block that shows the snapshot text plus a
   provenance line ("From customer address book" / "Custom address") derived
   from whether `ship_to_contact_id` is set.
2. Delivery Note record page + peek: same treatment, plus indicate when the
   destination was inherited from the source Sales Order.
3. Purchase Order record view + peek: relabel to **Deliver to (our location)**
   and resolve the warehouse/branch name from
   `deliver_to_warehouse_id` / `deliver_to_branch_id` via
   `formatInternalDestination`, falling back to the text snapshot.
4. GRN document: carry the originating PO's destination into
   `purchasesGrn.ts` instead of `null`.

Presentation-layer only — no schema or RPC changes in this phase.

## Phase 5 — Bill-to snapshot on financial documents — DONE

The real defect found this session: invoices resolved the customer address
live, so a master-data edit retroactively rewrote issued invoices.

- Migration added `bill_to_contact_id` + `billing_address` to `invoices`,
  `credit_notes`, `estimates`, `proforma_invoices`, and
  `remit_to_contact_id` + `remit_to_address` to `bills`. These are
  deliberately NOT foreign keys: a second FK to `contacts` makes every
  existing `contact:contacts(...)` embed ambiguous to PostgREST (~118 call
  sites). Integrity is enforced by the
  `public._assert_party_address_contact()` BEFORE INSERT/UPDATE trigger,
  which requires the party to exist and share the document's business.
- `src/services/documents/snapshots/partyAddress.ts` implements the rule
  once — stored snapshot first, live party only as a legacy fallback — and
  is applied in `salesInvoice`, `salesCreditNote`, `salesEstimate`,
  `salesProforma` and `purchasesBill`, mirrored in `generate-document` so
  screen and PDF cannot disagree.
- Capture at creation time: `captureBillToSnapshot` (invoices, estimates),
  `freezeBillToSnapshot` for the atomic-RPC documents (credit notes,
  proformas — the client cannot extend the server-side insert), and
  `captureRemitToSnapshot` on bills, resolved from `vendor_id`.
- Capture is best-effort by design: it never blocks document creation, and
  it writes NO link when no address resolves, so an unreadable
  (cross-business) party can never be linked.
- Historical rows are never retro-filled; a NULL snapshot keeps the legacy
  live-fallback rendering.

## Phase 6 — Documentation & guardrails — DONE

- `docs/adr/0080-address-master-data-model.md` authored: the address master
  model, counterparty vs. our-own-location split, the link-plus-text
  snapshot contract, and the reasoning behind trigger-based integrity.
- `docs/adr/0038-contact-master-data-model.md` carries an addendum stating
  that addresses are child contacts and that no `contact_addresses` table
  exists or may be added.
- ESLint rule `local/no-hand-rolled-address-format` (error) forbids gluing
  `address_line1` to `city`/`state`/`postal_code` outside the three
  canonical formatters. The four pre-existing violations (employee private
  info, employee quick view, customer record page, contact profile) were
  migrated to the new `formatAddressInline` helper; the codebase is clean
  under the rule.

## Phase 7 — Business-event tests — DONE

`src/test/addresses/address-lifecycle.test.ts` — 18 tests written as events
a user can cause, not helper unit tests:

- a party with several ship-to addresses (flagged default, role fallback,
  party-own fallback, billing never picking a delivery address);
- the default address changing AFTER a document exists — the printed
  snapshot must not move, and whitespace-only snapshots count as absent;
- a document referencing a party in another business — no addresses, no
  link, no leaked text on either the sales or the purchase side;
- GRN destination inheritance from the PO (warehouse, then branch, then the
  PO text; nothing invented when the PO has none; never the supplier);
- an issued invoice reprinted after the customer moves, plus the legacy
  pre-snapshot fallback.

Full run: 215 tests green across documents, addresses, contacts, sales and
lib; typecheck clean; lint clean.

## Technical notes

Files touched in Phase 4: `src/features/sales/orders/salesOrderView.tsx`,
`src/features/sales/delivery-notes/DeliveryNoteRecordPage.tsx` and
`DeliveryNotePeekSheet.tsx`,
`src/features/purchases/orders/purchaseOrderView.tsx`,
`src/services/documents/snapshots/purchasesGrn.ts`. Address formatting must go
through the existing resolvers; no new address-resolution helper.

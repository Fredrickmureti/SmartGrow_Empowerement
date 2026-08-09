# Business-Party & Address Lifecycle — Convergence Roadmap

Authoritative status file. Update it after every implementation step.

**Currently active:** Phase 4 (document rendering & snapshot verification)
**Next up:** Phase 5 (invoices, bills, credit notes, quotes — remaining document surfaces)

## Architecture (locked)

- `contacts` is the single address master. A party is a root contact; its
  saved addresses are child contacts carrying
  `child_address_type IN ('contact','invoice','delivery','other')`
  (ADR-0038 hierarchy).
- `is_default_shipping` / `is_default_billing` nominate defaults; a DB
  trigger keeps them unique per parent.
- `contact_addresses` is retired (dropped — it was orphaned, zero rows).
- Counterparty addresses (`src/lib/contactAddresses.ts`) and our own
  destinations — warehouses/branches (`src/lib/internalDestinations.ts`) —
  are deliberately separate resolvers. A PO's "Deliver to" is never a
  supplier address.
- Documents store BOTH a structured link (`ship_to_contact_id`,
  `deliver_to_warehouse_id` / `deliver_to_branch_id`) and the rendered
  address text, which is the immutable printed snapshot.

## Phase 1 — Schema convergence — DONE

- Dropped the orphaned `contact_addresses` table.
- Added `is_default_shipping` / `is_default_billing` to `contacts` plus the
  unique-default triggers.
- Added `ship_to_contact_id` to sales orders and delivery notes.
- Added `deliver_to_warehouse_id` / `deliver_to_branch_id` to purchase orders.
- Disambiguated every Supabase embed that now has two FKs to `contacts`
  (`SalesOrders.tsx`, `useSalesOrders`, `useSalesOrderApproval`,
  `useSalesOrderRecord`, `useBackorders`, `snapshots/salesOrder.ts`).
- Verified: typecheck clean.

## Phase 2 — Resolver layer — DONE

- `src/lib/contactAddresses.ts` — the ONE party-address resolver:
  `listPartyAddresses`, `pickAddressForRole`, `resolveShipTo`,
  `resolveBillTo`, `formatAddress`, `addressOptionLabel`.
- `src/lib/internalDestinations.ts` — warehouse/branch destinations:
  `listInternalDestinations`, `formatInternalDestination`.
- Verified: typecheck clean; both are the only implementations of their rule.

## Phase 3 — Address book UI + document pickers — DONE

- `src/features/contacts/ContactAddressBook.tsx` — add / edit / delete
  saved addresses and nominate default ship-to and bill-to. Mounted on
  the contact edit workspace for root parties only.
- `src/components/addresses/ShipToPicker.tsx` — customer-side selection
  with provenance ("from address book" vs "custom"), default
  preselection, and snapshot write-through.
- `src/components/addresses/DeliverToPicker.tsx` — purchase-side
  selection of OUR warehouse/branch.
- Wired into: Sales Order create + edit, Delivery Note create,
  Purchase Order create + edit.
- Migration: `update_sales_order_atomic` now persists
  `ship_to_contact_id` (only when the caller supplies the key, so other
  callers are unaffected).
- Verified: typecheck clean after every edit.

## Phase 4 — Document rendering & snapshots — ACTIVE

Confirmed already correct:

- `snapshots/salesOrder.ts`, `snapshots/salesDeliveryNote.ts`, and
  `snapshots/purchasesPo.ts` all read the document's own
  `shipping_address` column — i.e. the snapshot, not live master data.

Remaining in this phase:

- Render the ship-to block distinctly from the bill-to block on the SO,
  DN and PO record pages and peek sheets (today they show a single
  "Shipping address" row).
- Show the PO destination as "Deliver to (our location)" so it can never
  be misread as the supplier's address.

## Phase 5 — Remaining document surfaces — PENDING

- Invoices, credit notes, quotes/estimates: bill-to selection via
  `pickAddressForRole(..., "billing")` plus a stored snapshot.
- Bills and vendor credit notes: supplier remit-to.
- Decide per document whether a structured `bill_to_contact_id` column is
  warranted, mirroring `ship_to_contact_id`.

## Phase 6 — Documentation & guardrails — PENDING

- Write ADR-0080 (address master-data model) — referenced from
  `contactAddresses.ts` but not yet authored.
- Update `docs/adr/0038-contact-master-data-model.md` with the address
  child-row contract.
- Add an ESLint rule banning hand-rolled `address_line1 + city` string
  concatenation outside `src/lib/contactAddresses.ts`.

## Instructions for the next agent

1. **Verify Phase 3 before writing new code.** Open a contact in
   `/contacts-app/:id/edit`, add a delivery address, mark it default
   ship-to, then create a Sales Order for that customer and confirm the
   address preselects and the "From customer address book" badge shows.
   Repeat for a Purchase Order using the deliver-to picker. Confirm
   `sales_orders.ship_to_contact_id` and
   `purchase_orders.deliver_to_warehouse_id` actually persist by querying
   the rows after saving.
2. Confirm no feature module has reintroduced a second address resolver
   or a raw `contact_addresses` reference.
3. Then resume at **Phase 4 remaining items**, not elsewhere. Do not open
   Phase 5 until the SO/DN/PO record pages render ship-to and bill-to
   distinctly.

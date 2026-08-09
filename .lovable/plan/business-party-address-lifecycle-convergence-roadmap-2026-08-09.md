# Business-Party & Address Lifecycle — Convergence Roadmap

Authoritative status file. Update it after every implementation step.

**Currently active:** Phase 5 (invoices, credit notes, estimates — bill-to snapshot)
**Last completed:** Phase 4 (record rendering) — 2026-08-09

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

## Phase 5 — Bill-to snapshot on financial documents — PENDING

The real defect found this session: invoices resolve the customer address live.

- Add `billing_address` text (snapshot) and `bill_to_contact_id` to `invoices`,
  `credit_notes`, `estimates`; supplier remit-to equivalent on `bills`.
- Populate on confirm from `pickAddressForRole(..., "billing")`; never
  retro-fill historical rows — existing documents keep rendering the live
  fallback so nothing visibly changes for them.
- Switch `salesInvoice.ts` / `salesCreditNote.ts` / `salesEstimate.ts` /
  `purchasesBill.ts` to prefer the snapshot and fall back to the live contact
  only when the snapshot is null.
- Add a bill-to picker to the invoice/credit-note/estimate forms.

## Phase 6 — Documentation & guardrails — PENDING

- ADR-0080 (address master-data model), referenced from `contactAddresses.ts`
  but not yet authored.
- Update `docs/adr/0038-contact-master-data-model.md` with the address
  child-row contract.
- ESLint rule banning hand-rolled `address_line1 + city` concatenation outside
  `src/lib/contactAddresses.ts`.

## Phase 7 — Business-event tests — PENDING

Multiple ship-to addresses, default change after an order exists (historical
document must not move), cross-business address reference rejection, PO
destination inheritance into the GRN, invoice snapshot immutability.

## Technical notes

Files touched in Phase 4: `src/features/sales/orders/salesOrderView.tsx`,
`src/features/sales/delivery-notes/DeliveryNoteRecordPage.tsx` and
`DeliveryNotePeekSheet.tsx`,
`src/features/purchases/orders/purchaseOrderView.tsx`,
`src/services/documents/snapshots/purchasesGrn.ts`. Address formatting must go
through the existing resolvers; no new address-resolution helper.

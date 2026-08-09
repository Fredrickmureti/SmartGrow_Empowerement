# ADR-0080 — Address Master-Data Model & Document Address Snapshots

Status: Accepted
Date: 2026-08-09
Extends: ADR-0038 (contact master-data model)

## Context

Addresses appear on nearly every document the ERP prints: sales orders,
delivery notes, invoices, credit notes, estimates, proformas, purchase
orders, goods receipts, bills. Before this ADR the platform had three
unstated and mutually inconsistent behaviours:

1. Some documents stored a structured link to a contact and a rendered text
   snapshot (`sales_orders`, `delivery_notes`).
2. Some documents stored a link to one of OUR locations — a warehouse or a
   branch — under a column named like a counterparty address
   (`purchase_orders.deliver_to_warehouse_id`), and the UI labelled it
   "Shipping address" as though it belonged to the supplier.
3. Financial documents stored nothing and resolved the customer's address
   **live at render time** (`salesInvoice.ts` read `address_line1, city,
   state, postal_code` straight off `contacts`). Editing a customer's
   address silently rewrote every invoice ever issued to them — an audit
   defect, not a display quirk.

A short-lived `contact_addresses` table was also proposed at one point. It
does not exist in the database and must not be reintroduced.

## Decision

### 1. `contacts` is the single address master

A business party is a root `contacts` row (`parent_contact_id IS NULL`).
Its saved addresses are CHILD `contacts` rows carrying
`child_address_type IN ('contact','invoice','delivery','other')`. This is
the Odoo model ADR-0038 already committed to; addresses are not a separate
entity. `is_default_shipping` / `is_default_billing` nominate the defaults
and a DB trigger keeps each unique per parent. The party's own row is
always the implicit fallback address.

There is no `contact_addresses` table and there will not be one.

### 2. Counterparty addresses and our own locations are different concepts

- Counterparty (customer / supplier) addresses resolve through
  `src/lib/contactAddresses.ts`.
- Our own receiving and dispatch destinations are branches and warehouses
  and resolve through `src/lib/internalDestinations.ts`.

A purchase order's destination is never a supplier address; the UI says
**"Deliver to (our location)"**. A GRN inherits its destination from the
originating PO rather than resolving its own.

### 3. Every document stores BOTH a link and a text snapshot

| Concern | Column | Purpose |
| --- | --- | --- |
| Provenance | `*_contact_id` / `deliver_to_warehouse_id` | which record the address came from; drives "From customer address book" vs "Custom address" |
| Historical truth | `shipping_address` / `billing_address` / `remit_to_address` text | what the document printed, frozen |

The text column is written **once, at creation/issue time**, and is never
recomputed. Historical rows are never retro-filled: a row with a NULL
snapshot keeps rendering the live-party fallback, which is exactly the
behaviour it had before, so nothing visibly changes for existing documents.

### 4. Snapshot beats live master data, always

`resolveSnapshotAddress(stored, party)` in
`src/services/documents/snapshots/partyAddress.ts` is the one implementation
of the rule for the snapshot layer, mirrored in the `generate-document` edge
function so the PDF and the screen can never disagree.

### 5. Referential integrity via trigger, not foreign key

`invoices.bill_to_contact_id`, `credit_notes.bill_to_contact_id`,
`estimates.bill_to_contact_id`, `proforma_invoices.bill_to_contact_id` and
`bills.remit_to_contact_id` are **deliberately not foreign keys**.

Adding a second FK from these tables to `contacts` makes every existing
PostgREST embed of the form `contact:contacts(...)` ambiguous — PostgREST
can no longer infer which relationship to traverse — which would break
roughly 118 call sites across the app and the edge functions and force each
one to spell out the constraint name. Integrity is instead enforced by the
`public._assert_party_address_contact()` BEFORE INSERT/UPDATE trigger, which
requires the referenced party to exist and to belong to the same business
as the document. Cross-business address references are rejected at write
time, which is the property the FK was wanted for.

### 6. Exactly one formatter

`formatAddress` (UI), `formatPartyAddress` (snapshot builders) and
`formatInternalDestination` (our own locations) are the only places address
components are turned into text. The `local/no-hand-rolled-address-format`
ESLint rule fails the build on any other `address_line1 + city`
concatenation.

## Consequences

- An issued document's address is immutable. Editing a customer's address
  book changes future documents only.
- Address provenance is visible on record pages via one component,
  `src/components/addresses/AddressBlock.tsx`.
- New documents that print an address must add both columns and capture the
  snapshot at creation. Documents created through an atomic RPC use
  `freezeBillToSnapshot()` immediately after creation, since the client
  cannot extend the server-side insert.
- Snapshot capture is best-effort by design: it must never block or fail
  document creation. A missing snapshot degrades to the legacy live
  fallback, never to an error.

## Related

- ADR-0038 — contact master-data model (parent/commercial partner)
- ADR-0011 — delivery note as a logistics document
- ADR-0031 — AR/AP contact integrity triggers
- `src/lib/contactAddresses.ts`, `src/lib/internalDestinations.ts`,
  `src/services/documents/snapshots/partyAddress.ts`

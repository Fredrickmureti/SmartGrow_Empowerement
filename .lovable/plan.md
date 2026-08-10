# Contact & Address Domain — Audit Findings and Convergence Plan

## Verdict up front

No contact was wrongly created. The system did exactly what its own
architecture says it should do — and then failed to hide the result.

In this ERP (ADR-0038 "Contact Master-Data Model", ADR-0080 "Address Master-Data
Model") an address is **not** a separate table. It is a *child row of the same
`contacts` table*, carrying `parent_contact_id` = the party and
`child_address_type` = `delivery | invoice | contact | other`. This is the Odoo
model, and it is deliberate: it lets an address hold its own email/phone,
be a "contact person", and be referenced by documents like any party.

So "Save Address" correctly inserted a child `contacts` row whose `name` is the
address label. That row is the address. The bug is that the **Contacts list and
the customer/vendor pickers do not exclude child address rows**, so the address
surfaced in the UI as if it were a new business partner.

Verified against the live database (only 3 contact rows exist in this
workspace):

- `Nairobi Civil Court` — root party.
- `Nairobi` — `child_address_type = delivery`, `parent_contact_id` = the court.
  Created 2026-08-10 13:45 UTC, i.e. the incident row.
- No other child rows. **No corruption backlog to remediate.**

A second, real defect makes it worse: `contacts.type` has a column default of
`'customer'`. The address-book insert never sets `type`, so every saved address
is stamped `type = 'customer'` while `customer_rank` stays `0`. Pickers that use
the ADR-0038 back-compat clause `customer_rank.gt.0,type.eq.customer,type.eq.both`
(POS customer picker, contacts type filter, and peers) therefore treat addresses
as sellable customers.

### Area verdicts

| Area | Verdict |
| --- | --- |
| Contact identity | Correct (single table, `is_company`, ranks) |
| Address model | Correct in principle (ADR-0038/0080 child-row model) |
| Contact -> Address relationship | Correct (1 party -> many addresses, FK + commercial-partner trigger) |
| Persistence architecture | Needs improvement (direct table writes, no party/address write boundary) |
| Transaction boundaries | Correct for the incident (address save is its own atomic insert; contact save is separate and independent) |
| Idempotency | Needs improvement (repeat "Save Address" can duplicate a label) |
| Org/business isolation | Correct (org+business stamped, RLS scoped, write-lock trigger) |
| Historical snapshots | Correct (documents snapshot address text; test-covered) |
| Downstream integration | Needs improvement (readers filter parties inconsistently) |
| Contact creation architecture | Needs improvement (no server-side guard that an address row can never be a party) |

Bottom line: **the architecture is sound; the read boundary and one column
default are wrong.** No redesign.

## What will be built

### 1. One canonical "is a party" read rule

Add `applyPartyScope()` next to the existing address resolver so every list,
picker and report expresses party-ness identically: `child_address_type IS NULL`
(address rows excluded). Applied to the contacts list, paginated contacts, POS
customers, statement/aging/credit pickers, exports, merge and bulk actions, and
the command-palette customer provider. Address rows remain reachable exactly
where they should be: the party's address book, the ship-to/bill-to pickers, and
`listPartyAddresses`.

### 2. Stop stamping addresses as customers

Migration that makes the address child row role-neutral and keeps it that way:

- Extend the existing `contacts_sync_type_from_ranks` trigger so a row with
  `child_address_type IS NOT NULL` is forced to `customer_rank = 0`,
  `supplier_rank = 0`, `type = NULL`.
- Backfill the one existing address row.
- Add a CHECK enforcing that an address row always has a parent
  (`child_address_type IS NOT NULL` implies `parent_contact_id IS NOT NULL`), so
  an address can never exist as a free-floating party.

### 3. Address-save hardening

- The address book sends `child_address_type` (it already does) plus explicit
  role neutrality, and requires a non-empty label.
- Prevent double-submit duplicates: disable while saving, and a unique partial
  index on `(parent_contact_id, lower(name), child_address_type)` for address
  rows so a retried save collides instead of duplicating.

### 4. UI clarity at the point of confusion

In the address dialog, label the field "Address label (e.g. Warehouse, Head
Office)" with a one-line note that it names the address, not a new customer.
The contact list gets no new address entries at all after change 1.

### 5. Regression ratchets

New architecture tests that fail the build when:

- a contacts read used as a party list/picker omits the party scope;
- an insert into `contacts` carrying `child_address_type` also sets a non-zero
  rank or a `type`;
- an address row is written without `parent_contact_id`.

Plus behaviour tests: adding an address does not change the party's row or the
party count; editing an address does not create rows; a party keeps multiple
addresses of distinct types; repeated save does not duplicate; a cross-business
parent id is unreachable; documents still resolve and snapshot the right address.

## Technical notes

- Files touched: `src/lib/contactAddresses.ts` (new `applyPartyScope`),
  `src/hooks/useContacts.ts`, `src/hooks/useContactsPaginated.ts`,
  `src/hooks/pos/usePOSCustomers.ts`, the statement/aging/credit hooks,
  `src/lib/command/providers/customers.ts`,
  `src/components/contacts/{ContactMergeDialog,ContactBulkActions}.tsx`,
  `src/features/contacts/ContactAddressBook.tsx`, plus new tests under
  `src/test/architecture/` and `src/test/contacts/`.
- One migration: trigger extension, CHECK constraint, unique partial index,
  and the single-row backfill.
- ADR-0038 and ADR-0080 get an explicit "address rows are not parties; every
  party read filters `child_address_type IS NULL`" clause, and the same rule
  goes into project memory.
- Not doing: a separate `addresses` table, an RPC monopoly over contact writes,
  or any change to document address snapshots (already correct).

## Cleanup of the incident row

`Nairobi` stays — it is a legitimate delivery address for Nairobi Civil Court.
After the change it disappears from the Contacts list and from customer pickers,
and appears only in that party's address book. Nothing is deleted.

# Business-Party & Address Lifecycle — Audit Findings and Convergence Plan

## Phase 0 findings (verified against live schema and source, not assumptions)

**There are already two competing address models, and one of them is dead.**

1. `public.contact_addresses` exists (contact_id, organization_id, business_id, `address_type` default `'billing'`, label, line1/2, city, state, postal_code, country, `is_default`) with full RLS via `user_can_access_business` + `user_has_module_permission('contacts', …)`. It has **0 rows** and **zero references anywhere in `src/`** — the only hit is the generated `types.ts`. It is an orphaned table.
2. `public.contacts` implements the Odoo-style child-contact-as-address pattern instead: `parent_contact_id`, `commercial_partner_id` (trigger-maintained, ADR-0038), and `child_address_type CHECK IN ('contact','invoice','delivery','other')`. This one *is* wired: the Contact form exposes it as "Role at company", the CSV importer maps it, `useContactHierarchy` reads it. Currently 3 contacts, all with `child_address_type = NULL`.
3. Contacts also carry flat `address_line1/2` (plus city/state/postal/country) — the de-facto single address used by every document renderer.

**Transaction side is free text, in exactly three places:** `sales_orders.shipping_address`, `delivery_notes.shipping_address`, `purchase_orders.shipping_address` — all `text`, all typed by hand in the create/edit pages, no prefill, no inheritance, no FK. Estimates, invoices, credit notes and bills have **no** address column at all; their documents render the contact's flat address live.

**Destination concept already exists and is separate:** `warehouses.address`, `branches.address`, `businesses.address` (all `text`), plus `stock_movements.destination_location_id` / WMS `destination_location_id` for internal stock locations. Delivery notes already resolve a warehouse for their branch. So "our receiving destination" is a first-class concept in Inventory/WMS — it must not be folded into contact addresses.

**Documents:** `src/services/documents/snapshots/*` build a JSON snapshot persisted via `DocumentArtifactStore`. `salesOrder.ts`, `salesDeliveryNote.ts`, `purchasesPo.ts` copy `shipping_address` verbatim into the snapshot and join `contacts(name,email,phone,address_line1,city,state,postal_code,country)` **live at artifact-build time**. So the printed document freezes at first artifact generation, not at document confirmation — a real but narrow historical-truth gap.

**Data volume:** 0 sales orders, 0 purchase orders, 5 delivery notes (none with a shipping address), 1 contact with an address. Migration risk is effectively zero — no historical free text needs interpreting.

### Ranked problems

- **P0 — No ship-to selection anywhere.** Every SO/DN/PO forces retyping. The address master that would fix it exists but is unwired.
- **P0 — Purchase Order `shipping_address` is semantically wrong.** On a PO it means "where ABC Supplies delivers to us" — a *branch/warehouse* of ours, not a supplier address. Modelling it as free text next to a vendor picker invites entering the supplier's address.
- **P1 — Two address models competing** (`contact_addresses` vs `contacts.child_address_type`). Must pick one before anything consumes either.
- **P1 — No transaction snapshot at confirmation.** Counterparty address is resolved when the PDF is first built, not when the document is confirmed.
- **P2 — Delivery Note does not inherit its Sales Order destination.**
- **P3 — Contact form has no address-book UI**, and shows "Role at company" without explaining it is Odoo's address-role concept.

### Architecture decision

**Keep `contacts` + `parent_contact_id` + `child_address_type` as the address master. Drop `contact_addresses`.**

Reasoning: the child-contact model is the one the platform already committed to (ADR-0038 hierarchy, `commercial_partner_id` trigger, importer, hierarchy hook), it is Odoo's model, and it gives each ship-to its own contact person, email and phone — which delivery and invoicing both need. `contact_addresses` is a flat second-class table with no consumers, no contact person, and no relationship to `commercial_partner_id`. Two models cannot both exist per §18.

Concept map (no new generic `shipping_address` bucket):

- Party identity + legal address → `contacts` (root, `is_company`)
- Bill-to → child contact with `child_address_type='invoice'`, falling back to the root
- Ship-to → child contact with `child_address_type='delivery'`, falling back to the root
- **Our** receiving/dispatch destination → `branches` / `warehouses` (never a contact)
- Internal stock destination → existing WMS `destination_location_id` (untouched)

## What we will build

### Phase 1 — Foundation
- Migration: drop the orphaned, empty `contact_addresses` table (with its policies).
- Migration: partial index on `contacts (parent_contact_id, child_address_type)` for address-book lookups; add `is_default_shipping` / `is_default_billing` booleans on `contacts` for child rows only, with a trigger enforcing at most one default of each kind per commercial-partner family.
- `src/lib/contactAddresses.ts` — the **single** resolver: `listPartyAddresses(contactId)`, `resolveShipTo(contactId)`, `resolveBillTo(contactId)`, `formatAddress(row)`. No other module may reimplement resolution.

### Phase 2 — Contact address book
- Add an "Addresses" section to `ContactRecordForm` (edit mode): list child address contacts, add/edit/remove, mark default ship-to / bill-to. Progressive disclosure — collapsed by default, and the section only surfaces on company contacts.
- Clarify the existing "Role at company" select as the address-role it is.

### Phase 3 — Sales convergence
- Sales Order: replace the free-text textarea with a **Ship to** picker over the customer's saved addresses, auto-selected to the default, plus an explicit "Use a custom address" escape hatch. Persist `ship_to_contact_id uuid REFERENCES contacts(id)` alongside the existing `shipping_address` text, which becomes the **snapshot** written server-side at confirmation from the selected address (or the custom text).
- Delivery Note: inherit `ship_to_contact_id` + snapshot from its source Sales Order when created from one; editable only while draft; changes recorded in the existing audit log.
- Estimate / Invoice / Credit Note: no schema change. They keep rendering the party's address; we only route them through the shared resolver so UI and PDF agree.

### Phase 4 — Purchasing convergence
- Purchase Order: replace free-text `shipping_address` with **Deliver to** — a picker over *our* branches and warehouses (`deliver_to_branch_id` / `deliver_to_warehouse_id`), snapshotting the resolved address text into the existing `shipping_address` column for the printed PO. Supplier address stays where it is: on the contact, rendered in the vendor block.
- Goods Receipt inherits the PO destination; vendor bill unchanged.

### Phase 5 — Documents
- Point all snapshot builders (`salesOrder`, `salesDeliveryNote`, `purchasesPo`, `purchasesGrn`, `salesInvoice`, `salesEstimate`, `salesCreditNote`, `purchasesBill`) at the shared resolver so no builder hand-rolls address logic.
- Move counterparty-address capture to document confirmation rather than first artifact build, so a later master-data edit cannot rewrite a confirmed document.

### Phase 6 — Finance
Verification only. No journal, tax, AR/AP or posting change. We confirm invoices and credit notes read the frozen snapshot, and check whether eTIMS transmission carries an address field.

### Phase 7 — Hardening
- SQL tests: default-uniqueness trigger, cross-business address reference rejected server-side, RLS on child address contacts.
- Frontend/lifecycle tests: customer with 0/1/many addresses; both-roles contact; change default after an order exists and assert the confirmed SO/DN/PDF is unchanged; SO→DN inheritance; PO→GRN destination inheritance.
- ESLint guard: no direct writes to `shipping_address` outside the resolver/snapshot layer.
- New ADR documenting the party/address decision, superseding nothing but extending ADR-0038 and ADR-0079.

## Migration impact

Nothing to backfill: `contact_addresses` is empty, and there are no sales or purchase orders with free-text addresses. The 5 existing delivery notes have no shipping address. Existing `shipping_address` columns are retained as snapshot storage, so no historical text is discarded or reinterpreted.

## Explicitly not doing

- No `default_shipping_address_id` on contacts.
- No second address table, no address-resolution engine B.
- No change to WMS `destination_location_id`, stock movements, or any accounting engine.
- No migration of document FKs from `vendor_id`/`contact_id` (ADR-0079 holds).

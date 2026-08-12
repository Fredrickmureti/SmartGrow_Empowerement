# ADR-0079 — Procurement Party vs Role (Contact ↔ Supplier dual-key model)

Status: Accepted
Date: 2026-07-18
Related: ADR-0038 (Contact Master-Data Model), Procurement P1 (`suppliers` master)

## Context

Two entities model a single supplier today:

- `public.contacts` — the party / identity record (ADR-0038). Owns name,
  addresses, tax id, `default_payable_account_id`,
  `default_expense_account_id`, `default_tax_rate_id`, `default_currency`,
  `withholding_tax_rate`, `supplier_rank`.
- `public.suppliers` — the procurement lifecycle record (Batch A). Joined
  1:1 to a contacts row via `contact_id`. Owns category, qualification
  state, preferred rank, hold state, incoterms, lead time, minimum order
  value, procurement default currency, default payment term.

Every procurement document (`purchase_orders.vendor_id`, `bills.vendor_id`,
`rfq_vendors.vendor_id`, `purchase_returns.vendor_id`,
`vendor_credit_notes`) references `contacts.id`, **not** `suppliers.id`.
No document FK points at `suppliers`. This is easy to misread as a bug.

## Decision

Lock in the party-vs-role split explicitly:

1. **Contact is the party (system of record for identity).** Every
   procurement document keys off `contacts.id`. Audit lineage points at
   the party the document was issued to. This will not change.
2. **Supplier is the specialised business role.** It is 1:1 with the
   contact via `suppliers.contact_id`, and owns only procurement
   lifecycle fields. A contact can exist without a supplier row (e.g.
   ad-hoc one-off vendor, historical import); a supplier row cannot
   exist without a contact.
3. **Joining rule.** Any read that needs both identity and lifecycle
   joins `suppliers` to `contacts` on `contact_id`. Any write that
   creates a supplier must upsert the contact first (see
   `SupplierCreatePage.tsx`).
4. **AP / Finance defaults stay on Contact.** `default_payable_account_id`,
   `default_expense_account_id`, `default_tax_rate_id`,
   `withholding_tax_rate` are properties of the party — Finance,
   Statements, and Aged Payables already depend on them. Suppliers must
   not duplicate them.
5. **Currency has two homes on purpose.**
   `contacts.default_currency` is the identity default (used by bills /
   invoices / statements). `suppliers.default_currency` is the
   procurement default (used by PO / RFQ / contract). They may differ
   for tenants that transact in one currency but bill in another.
   Both should default from `businesses.base_currency` at create time.

## Non-goals

- Migrating document FKs from `vendor_id → contacts.id` to
  `supplier_id → suppliers.id`. Rejected — would break audit lineage
  and force every historical bill to have a supplier row.
- Merging `contacts` and `suppliers` into a single table. Rejected —
  breaks Contact's role as the shared party across Sales, CRM, Portal,
  Payroll counterparties.

## Consequences

- New consumers must read this ADR before adding a `supplier_id` FK to
  any transactional document. The answer is "use `contact_id` /
  `vendor_id` and join to `suppliers` on `contact_id`".
- Deleting a contact that has a linked supplier row must be blocked (a
  DB trigger enforces this via the FK from `suppliers.contact_id` —
  verified via `information_schema.referential_constraints`).
- The legacy `/purchases/vendors` route (filtered Contacts view) is the
  only surface today that edits Contact-side AP defaults for a
  vendor-role contact. It stays until the Supplier record page absorbs
  a "Finance defaults" section that writes back to the contact row
  (queued as **Batch K-Retire**).

## Addendum — 2026-08-12 (takeover wave)

- `public.v_party_supplier` is the sanctioned read view resolving party →
  supplier role. Reads needing identity plus lifecycle use it rather than
  hand-rolled joins.
- RFQ v2 columns (`rfq_invitations.supplier_id`, `rfq_quotations.supplier_id`,
  `rfq_awards.supplier_id`, `rfq_quotation_attachments.supplier_id`) reference
  `contacts(id)`, not `suppliers(id)`. A physical rename to `vendor_id` was
  considered and **rejected**: ~20 RPCs read those columns and the rename
  carries lifecycle-breaking risk with no behavioural gain. The columns instead
  carry database comments stating the party key, and this ADR is the authority.
- `_assert_supplier_purchasable` is the single purchasability authority
  (lifecycle state + Approved Supplier List). Its trigger now covers
  `purchase_orders`, `bills`, `rfq_invitations`, `purchase_returns`,
  `vendor_credit_notes` and `expenses`. `usePurchasableVendors` is a UI
  convenience, never the control.
- `supplier_item_terms` is the only vendor item-terms store; the
  `vendor_pricelists` compatibility view and its INSTEAD OF trigger are retired.

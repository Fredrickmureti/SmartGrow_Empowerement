---
name: Supplier / vendor master (party vs role)
description: ADR-0079 party↔role split, purchasability gate coverage, RPC-only supplier writes, supplier_item_terms convergence, Supplier 360 surfaces
type: feature
---

# Supplier / vendor master

## Party vs role (ADR-0079)
- `contacts` is the party: identity, addresses, tax id, AP/finance defaults
  (`default_payable_account_id`, `default_expense_account_id`,
  `default_tax_rate_id`, `withholding_tax_rate`, `default_currency`).
- `suppliers` is the procurement role, 1:1 with the party via
  `suppliers.contact_id`: lifecycle state, category, preferred rank,
  incoterms, lead time, minimum order value, procurement default currency
  and payment term.
- **Every purchasing document keys `vendor_id → contacts.id`**, never
  `suppliers.id`. RFQ v2 columns are physically named `supplier_id` but also
  reference `contacts(id)` — documented in-database via column comments; do
  not "fix" them by repointing at `suppliers`.
- `v_party_supplier` is the read view that resolves party → supplier role
  when a query needs both.
- The role is auto-provisioned on first procurement use
  (`_contacts_provision_supplier_role` / `ensure_supplier_for_contact`), so a
  contact with no supplier row is NOT held.

## Purchasability gate
`public._assert_supplier_purchasable()` is the single authority: it rejects
parties whose supplier role is `draft`, `qualifying`, `suspended`, `blocked`
or `archived`, and enforces the Approved Supplier List for categories with
`asl_enforced`. Gate triggers exist on `purchase_orders`, `bills`,
`rfq_invitations`, `purchase_returns`, `vendor_credit_notes` and `expenses`.
UI pickers use `usePurchasableVendors` — convenience only, never the control.
Frozen by `src/test/architecture/supplier-purchasability-gate.test.ts`.

## Write seam
Client code never writes `suppliers` or its satellites
(`supplier_qualifications`, `supplier_compliance_checks`,
`supplier_bank_accounts`, `supplier_item_terms`, `supplier_terms_changes`,
`supplier_lifecycle_events`, `approved_supplier_list`). All mutations go
through SECURITY DEFINER RPCs so the outbox and audit tables stay
authoritative. Lifecycle is monotonic on `lifecycle_seq`, row-locked, no-op
safe and outbox-idempotent. Exactly one `create_supplier` overload may exist
(PGRST203 ambiguity).

## Item terms
`supplier_item_terms` is the only vendor item-price/lead-time store. The
legacy `vendor_pricelists` view and its INSTEAD OF trigger are retired;
writes go through `upsert_supplier_item_terms` /
`deactivate_supplier_item_terms`, which resolve contact → supplier role
server-side.

## Supplier 360
`SupplierRecordPage` + `SupplierRecordTabs` carry Overview, Terms (writes via
`update_supplier_terms`, history from `supplier_terms_changes`), Item terms,
ASL, Qualification, Compliance, Banking, Payments, Contracts, Requisitions,
Orders, Bills, Returns and History (`supplier_lifecycle_events`).

## Deferred on purpose
Vendor-portal identity stays on contacts/portal users. Supplier performance
scoring waits for accumulated GRN quality and on-time data.

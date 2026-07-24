# ADR 0093 — Legal Recipient master data

Date: 2026-07-24
Status: Accepted (Phase 1 of the Legal Orders enterprise program)

## Context

Prior to this ADR, a legal order (garnishment) referenced its third-party
recipient two ways:

1. `legal_orders_records.payee_contact_id → contacts.id` — optional link
   to a Contact.
2. Free-text snapshot fields (`payee_name`, `payee_bank`, `payee_account`,
   `payee_reference`) on the order itself.

That model made the recipient a per-order attribute. There was no way to
say "these 40 orders across 40 employees all pay the same court" as a
single master-data fact, no dedupe, no shared bank/reference defaults,
and no place to hang recipient-level policy (statement cadence, cap-
exempt default, always-first default, jurisdiction). Every mature
payroll ERP models this as a first-class aggregate:

- SAP HCM — "Vendor for garnishment" links garnishments to a shared vendor.
- Oracle HCM Fusion — Third-Party Payment Payee is a master record.
- Workday — Third Party Payee holds bank + address + tax id centrally.
- Dynamics 365 F&O — Garnishment vendor account is the shared party.
- Odoo — `l10n_*_deduction_partner` is a `res.partner` reused across employees.

## Decision

Introduce `public.legal_recipients` as the enterprise recipient
aggregate, typed by a pack-seedable catalog `public.legal_recipient_types`
and optionally backed by a `contacts` row for vendor-identity reuse.
`legal_orders_records.recipient_id` links each order to its master row.

Structural dedupe is enforced with a unique index on
`(organization_id, contact_id, recipient_type_code, jurisdiction_country,
jurisdiction_region)`. A `legal_recipient_merge(source, target)` RPC
consolidates duplicates and moves all attached orders atomically.

Recipient types are pack-driven — the platform seeds nine industry-
standard categories (court, child_support_agency, tax_authority,
creditor, collection_agency, bank_trustee, credit_union, labor_ministry,
other). Localization packs add jurisdiction-specific rows without any
change to application code.

The legacy `payee_*` snapshot columns and `payee_contact_id` are
retained. They are demoted to denormalized snapshots of the linked
recipient and remain the shape returned by existing APIs. A later phase
flips writers to write through `recipient_id` and treats the snapshot
columns as read-only derived data.

## Consequences

- Recipient-level policy (always-first default, cap-exempt default,
  statement cadence, default payment method) now has one canonical home.
- Remittance batches can be grouped by `recipient_id` instead of
  reconstructing groupings from `payee_*` free text, enabling clean
  per-recipient statements and bank-file grouping.
- Duplicate recipients across employees are structurally impossible for
  new writes (unique index) and cleanable via the merge RPC.
- No country-specific behaviour is added; recipient types are pack data.
- `Garnishment Payable ≠ PAYE Payable` (ADR-0092) is unaffected.

## Follow-up phases

- Phase 2 — canonical FSM + engine RPC consuming `recipient_id` for
  priority and aggregate-cap decisions where the recipient type carries
  the default.
- Phase 3 — per-recipient liability accounts via `default_account_settings`
  role `garnishment_payable`, closing the Liability → Remittance → Bank →
  GL → Reconciliation loop with a writable batch builder.
- Phase 4 — operator workspace that treats Recipient as a first-class
  tab alongside Orders, Remittance Batches, Reports, and Audit.

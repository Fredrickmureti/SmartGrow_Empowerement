# ADR-0038 — Contact Master-Data Model

Status: Accepted
Date: 2026-06-28
Supersedes: none

## Context

The `contacts` table is the master-data foundation for Sales, CRM, Purchases,
Finance, POS, Statements, Dashboards, and every future ERP module. Without a
canonical record of the model, every consumer reinvents its own interpretation
of "is this a customer?", "who is the parent company?", and "do child
balances roll up?" — and they diverge.

This ADR captures the contract that every consumer must follow. It is not a
proposal; it documents the model that already exists in the schema after the
Phase 1–7 work.

## Decision

### One table, two flavours

- Single `public.contacts` table holds **both individuals and companies**.
- `is_company boolean NOT NULL DEFAULT false` distinguishes the two.
- Companies never have a `parent_contact_id`. Individuals may.
- No separate `companies` table. Ever.

### Hierarchy

- `parent_contact_id uuid NULL REFERENCES contacts(id)` — direct parent.
- `commercial_partner_id uuid NOT NULL` — the **root of the parent chain**,
  maintained by the `set_commercial_partner_id` trigger (migration
  `20260424073005`). A root contact's commercial partner is itself.
- Indexed for the rollup queries in §"Reporting rollup" below.

### Roles

- Canonical: `customer_rank smallint NOT NULL DEFAULT 0` and
  `supplier_rank smallint NOT NULL DEFAULT 0`. `>0` means the contact plays
  that role. The rank value itself is reserved for future tiering and is not
  interpreted today beyond `0 / >0`.
- Back-compat: `type` enum (`customer | supplier | both | null`) is a
  **denormalised mirror** written by `typeFromRoles` in
  `src/lib/contactRoles.ts`. Every write that touches the ranks must also
  refresh `type`. Reads should treat the ranks as authoritative.
- A contact may simultaneously be customer, supplier, and a child of a
  parent company — no duplication.

### Reporting rollup

- **Reads that aggregate balances** (statements, dunning, credit checks,
  customer/vendor 360 views) widen the contact id into the
  commercial-partner family via `expandToCommercialPartnerSet` in
  `src/lib/contactHierarchy.ts`. This is the single helper; no other code
  may reimplement the rule.
- **Writes / posting** (invoice / bill creation, payment allocation, JE
  postings) record against the actual `customer_id` / `vendor_id`. They
  never substitute the commercial partner — audit lineage must point at the
  party the document was issued to.
- List views (all customers, all vendors) do NOT roll up by default, to
  avoid double-counting. Detail / statement views may opt in via an
  explicit flag on the page.

### Consumer obligations

Every new consumer that touches contacts MUST:

1. Filter customers / suppliers via `customer_rank.gt.0` / `supplier_rank.gt.0`
   (with the legacy `type` OR-clause for back-compat) — see
   `useContactsPaginated.ts:91-95` for the canonical shape.
2. Use `rolesFromContact` / `typeFromRoles` from `src/lib/contactRoles.ts`
   instead of inspecting `type` directly.
3. Use `expandToCommercialPartnerSet` from `src/lib/contactHierarchy.ts`
   when the read aggregates by party.
4. Read the parent's display name through the existing
   `parent:contacts!parent_contact_id(name)` join, not by hand-rolling a
   second query.

## Non-goals

- **Studio metadata-driven form rendering.** Contact forms remain
  hand-coded; a generic `SchemaForm` renderer + per-entity migration is a
  separate platform initiative.
- **Portal-user provisioning UX.**
- **Rewriting the posting path** to record against `commercial_partner_id` —
  would break audit lineage and Odoo parity.
- **Cross-business contact sharing.** Each contact belongs to one
  `business_id`; a parent and a child must share a business.

## Consequences

- Future consumers have one document to read before touching contacts.
- The legacy `type` column stays, but only as a derived mirror; new code
  must not branch on it without the rank OR-clause.
- AR/AP balance pages can adopt the rollup with a one-line call to
  `expandToCommercialPartnerSet` once UX is designed. Until then,
  Statements is the only consumer that aggregates.

## Related

- ADR-0027 / 0028 — allocation-first customer / vendor payments
- ADR-0031 — AR/AP contact integrity triggers
- ADR-0033 — single AR/AP open-items engine
- Migration `20260424073005` — `commercial_partner_id` column + trigger
## Addendum (2026-08-09) — Addresses are child contacts

Saved addresses are not a separate entity. A party's addresses are CHILD
`contacts` rows (`parent_contact_id = <party>`) carrying
`child_address_type IN ('contact','invoice','delivery','other')`, with
`is_default_shipping` / `is_default_billing` nominating the defaults (a DB
trigger keeps each unique per parent). The party's own row is the implicit
fallback address. No `contact_addresses` table exists, and none may be
added.

Because a parent and a child must share a `business_id`, an address can
never be borrowed across businesses — the same rule the document-level
`_assert_party_address_contact()` trigger re-checks when a document links
to a bill-to / remit-to party.

The full contract — resolution precedence, the link-plus-text snapshot rule
for documents, and why the bill-to links are triggers rather than foreign
keys — is in ADR-0080 (address master-data model & document address
snapshots).

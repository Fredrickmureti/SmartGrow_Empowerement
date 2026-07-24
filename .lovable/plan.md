# Legal Order Recipient — Contact Linking & Inline Creation

## The real problem

Today `LinkRecipientDialog` searches **all** contacts. That surfaces customers, which are almost never legitimate garnishment recipients, and offers no way to create a fresh recipient without leaving Payroll for the Contacts app. Meanwhile we don't want to invent a parallel "recipient master" that duplicates identity — ADR-0038/0079/0093 already lock in Contact as the single party record.

## How the big platforms solve this

| Platform | Pattern |
|---|---|
| SAP HCM | Garnishment recipient is a **Vendor** in a dedicated *vendor account group* (e.g. `GARN`). Grouping keeps AP clean; posting still uses the vendor master. |
| Oracle HCM Fusion | **Third-Party Payment Payee** is its own master, optionally linked to a Supplier for banking. Payee ≠ supplier by default. |
| Workday | **Third Party Payee** master owns identity + banking, exists whether or not the payee is a supplier. |
| Dynamics 365 F&O | Garnishment recipient is a Vendor in a **vendor group** (`GARN`) with dedicated posting profile. |
| Odoo | `res.partner` **tagged** with a category (e.g. `Garnishment recipient`); the partner is *neither customer nor vendor* unless separately flagged. Promotion to vendor is a rank flip, not a new record. |

The common thread: **one party record, role expressed by tag/group/rank, never by duplication**. Odoo's rank-flip model is the closest fit to our existing `customer_rank` / `supplier_rank` schema and ADR-0038.

## Decision

Adopt the **"party-only recipient contact"** pattern:

- A recipient Contact is created with `customer_rank = 0` **and** `supplier_rank = 0`. Its recipient role is expressed by the presence of a `legal_recipients` row pointing at it (`recipient_role_via_link`). No new column, no new rank enum.
- Contacts list filters (`Customers` / `Vendors`) already require `rank > 0`, so party-only recipients stay invisible there — the workspace stays clean.
- The `legal_recipients` row (already the enterprise aggregate per ADR-0093) is what Payroll/Remittance keys off. Contacts UI is untouched.
- Promotion path: if this party ever becomes a vendor, set `supplier_rank = 1` + fill AP defaults on the same Contact. No merge, no data move. Matches ADR-0038/0079.
- Legitimate reuse: existing **vendors** (e.g. a SACCO already paid via AP) can be picked as recipients directly — no duplicate contact.

## Changes

### 1. Scope the recipient picker (`LinkRecipientDialog.tsx`)

Search results become **role-aware**, sorted and filtered by suitability:

```text
Preferred        → contacts already linked as a legal_recipient
Allowed          → suppliers (supplier_rank > 0) — SACCOs, existing AP vendors
Party-only       → contacts with rank 0/0 (created for this purpose)
Hidden by default → customers (customer_rank > 0 AND supplier_rank = 0)
                    revealed only via a "Include customers" toggle,
                    with an inline warning "Usually not a recipient"
```

Each row shows badges (`Recipient`, `Vendor`, `Party-only`, `Customer`) so the user cannot mislink blindly. Search covers name/email/phone (the `contact_type` bug is already fixed).

### 2. Inline "Create recipient" flow

Empty state and a persistent `+ New recipient` button open a **minimal** form inside the dialog (no route change):

- Name (required)
- Recipient type (dropdown from `legal_recipient_types`)
- Jurisdiction country / region (defaults from the order)
- Contact channel: email, phone (optional)
- Banking: bank name, account number, reference (optional; can be filled later before batch build)

On submit:
1. Insert `public.contacts` row with `customer_rank = 0`, `supplier_rank = 0`, `type = null`, `is_company = true` by default, `business_id = current`.
2. Call existing `legal_recipient_upsert(...)` RPC with the new `contact_id`, recipient type, jurisdiction, and bank fields. The RPC's unique index still enforces dedupe.
3. Attach the returned `recipient_id` to the order (same path the current dialog already uses).

All in one transaction from the client's perspective (RPC wraps the two writes). No orphan contacts on failure.

### 3. Clarify the "issuing authority" affordance

The existing `legal_order_use_authority_as_recipient` RPC stays and continues to work — but the Orders row hint changes from **"Recipient not linked"** to a two-option chooser: `Use issuing authority` | `Link/Create recipient…`. This makes it obvious the authority is a fast path, not the only path.

### 4. Docs

Amend **ADR-0093** with a new section *"Recipient Contact roles"* documenting:
- The party-only contact pattern (rank 0/0) as canonical for pure recipients.
- Vendor reuse is allowed and preferred when the party already exists in AP.
- Customers are hidden from the picker unless explicitly opted in.
- Promotion from party-only → vendor is a rank flip, not a new record.

No schema migration is required. No new columns. No new tables.

## Technical notes

- Files touched:
  - `src/components/hr/payroll/LinkRecipientDialog.tsx` — role-scoped search, badges, customer toggle, inline "New recipient" panel.
  - `src/pages/hr/payroll/Garnishments.tsx` — split the "Recipient not linked" chip into two clear actions.
  - `docs/adr/0093-legal-recipient-master-data.md` — new section.
- Query shape (Supabase): fetch candidates in one call using `contacts` with a left join projection to `legal_recipients` (to compute the `Recipient` badge) plus `customer_rank`/`supplier_rank` for the other badges. No new RLS.
- Reuses existing RPCs: `legal_recipient_upsert`, `legal_order_link_recipient`, `legal_order_use_authority_as_recipient`. No new SQL unless we want a small helper RPC to fuse steps (1)+(2) — optional, decided during implementation based on whether client-side atomicity is acceptable.
- Contacts create policy already allows `authenticated` inserts scoped to `business_id`; no policy change needed.

## Out of scope

- Merging existing customer-flagged recipients back to party-only.
- A separate "Recipients" master screen inside Contacts app (the Legal Orders → Recipients tab already covers this).
- Any change to posting / GL — recipient accrual accounts remain governed by `default_account_settings` role `garnishment_payable`.

## Why not add a `recipient_rank` column

Considered and rejected: it would fork ADR-0038's two-rank contract, force every consumer to learn a third role, and duplicate what `legal_recipients` already encodes. Odoo's partner-category / SAP's vendor-group precedent is exactly this: role via linkage, not via a new identity flag.
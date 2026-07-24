# Unify Issuing Authority ↔ Recipient Contact

## 1. Verdict (what's actually broken)

The user is right that there's a disconnection. Confirmed against schema and code:

- `legal_order_authorities` — curated master of courts/agencies. Holds payee bank/account/reference defaults, remittance schedule, jurisdiction. **Does not link to `contacts` at all** (verified: no `contact_id` column).
- `legal_recipients` — the remittance target. Optionally references `authority_id` and/or `contact_id`. Bank-file/AP pipeline requires `contact_id`.
- `contacts` — the payment/AP spine. This is where `LinkRecipientDialog` searches.

Result: the operator creates an "issuing authority" during Step 1 of the garnishment (via `AuthorityPicker`), and later `LinkRecipientDialog` asks them to pick a **Contact** from a *different* table — for the same real-world entity ("Court name, agency, creditor…"). Nothing bridges the two. That's why the search is empty even when an authority is set on the order. The "use issuing authority as recipient" RPC papers over this for accruals/statements, but it does **not** create the Contact that the bank file later needs — so the operator still has to hand-link a Contact, and the empty search reappears.

Verified data example: order `0dfb6e04…` has `authority_id → Nairobi Civil Court`, `recipient_id` set from that authority, `payee_contact_id = null`. Contact search is empty because no matching Contact was ever provisioned.

## 2. How big systems handle this

- **Odoo**: single `res.partner` spine. Courts, tax authorities, SACCOs, vendors, customers are all partners with tags/ranks. Third-party payment master (`hr.salary.attachment`) just points at a partner. There is no parallel "authority" table.
- **SAP HCM**: third-party remittance uses Business Partner (BP) as the banking/AP substrate; the "authority" facet is metadata on top of the BP, never a rival identity.
- **Workday**: "Payee" is a supplier facet of Person/Company; garnishment payee resolves to the same supplier used by AP.

Pattern: **one party spine (Contact), authority is a facet/role on top** — never a parallel identity.

## 3. Chosen approach

Keep `legal_order_authorities` (it holds statutory/jurisdictional metadata that doesn't belong on a per-tenant contact — remittance schedule ref, reporting binding, jurisdiction country/region), but make every authority own a **party-only Contact** for the AP/banking pipeline. Authority becomes a facet layered on a Contact, not a rival identity.

Rejected alternative: fold authorities into `contacts` entirely (Odoo-pure). Too invasive for now — authority rows carry jurisdiction/statutory metadata (`remittance_schedule_ref`, `reporting_binding_ref`, `jurisdiction_*`) that `contacts` doesn't model, and localization packs seed authorities but not contacts. Recorded as a future ADR consideration.

## 4. Changes

### 4.1 Schema (migration)

- Add `legal_order_authorities.contact_id uuid` (nullable, FK `contacts.id`, unique per org).
- Backfill: for each existing authority, create a party-only Contact (`customer_rank = 0`, `supplier_rank = 0`, `type = null`) from `name / contact_email / contact_phone / address / jurisdiction_country`, then stamp `authority.contact_id`. Idempotent — reuse an existing party-only Contact with the same name if one exists.
- Trigger `legal_order_authority_ensure_contact()` (BEFORE INSERT/UPDATE): if `contact_id IS NULL`, create/link a party-only Contact in the same tenant.
- Update RPC `legal_order_use_authority_as_recipient(p_order_id)`:
  - Use `authority.contact_id` as the recipient's `contact_id` (not just authority metadata).
  - Stamp `legal_orders_records.payee_contact_id = authority.contact_id` too, so the bank-file guard is satisfied without a second manual step.

### 4.2 `LinkRecipientDialog` (`src/components/hr/payroll/LinkRecipientDialog.tsx`)

- Add a new candidate section **"Issuing authorities"** above the Contacts list, sourced from `legal_order_authorities` (search on `name`, `code`, `authority_type`, jurisdiction). Each row shows an `Authority` badge and its authority_type (court/agency/…).
- Selecting an authority calls the same `legal_order_attach_contact` / `legal_recipient_link_contact` RPC with `authority.contact_id` — one click, no manual party-only creation.
- Keep the existing Contacts list (Recipient / Vendor / Party-only / Customer) and inline "New recipient" panel. These stay for cases where the recipient is not a curated authority (individual creditor, SACCO not yet seeded).
- Empty-state copy updated: "No matches. Recipients are usually a curated **issuing authority** (court/agency) or a **Contact** (creditor/SACCO). Create a new recipient below, or open the Authorities admin to add one."

### 4.3 `Garnishments.tsx`

- When an order has `authority_id` and no `recipient_id`, the existing "use issuing authority as recipient" button now also links the Contact and satisfies the bank-file guard. Update tooltip to reflect that a Contact is no longer required afterwards.
- The "recipient not linked" badge only fires when neither authority nor recipient is set.

### 4.4 Authorities admin (`AuthorityPicker` create flow, if any inline create exists)

- No UI change required — the DB trigger provisions the Contact on insert. New authorities are AP-ready out of the box.

### 4.5 ADR

- Update `docs/adr/0093-legal-recipient-master-data.md` with a new section **"Authority ↔ Contact spine"**: authority owns a party-only Contact via `contact_id`; localization-pack-seeded authorities are auto-provisioned by trigger; single party spine for the AP/banking pipeline; jurisdictional metadata stays on authority.

## 5. Verification

- Migration succeeds; `SELECT count(*) FROM legal_order_authorities WHERE contact_id IS NULL` returns 0.
- The existing Nairobi Civil Court order: after re-running "use issuing authority as recipient" (or a one-off backfill), `legal_recipients.contact_id` and `legal_orders_records.payee_contact_id` are both populated.
- `LinkRecipientDialog` opened on any order shows the seeded authorities in the top section and search works across both authorities and contacts.
- Existing tests `legal-orders-phase7-remittance-cycle.test.ts` and `legal-orders-phase8-audit.test.ts` still pass.
- Typecheck clean.

## 6. Out of scope

- Migrating authorities into `contacts` outright (Odoo-pure). Recorded for a future ADR.
- Changing how localization packs seed authorities.
- Recipient-side "always_first" / aggregate-cap policies — untouched.

## Technical details

```text
┌─────────────────────────┐        ┌──────────────────┐
│ legal_order_authorities │──1:1──▶│    contacts      │  (party-only, rank 0/0)
│  + statutory metadata   │        │  AP/banking spine │
└──────────┬──────────────┘        └────────▲─────────┘
           │ authority_id                    │ contact_id
           ▼                                  │
┌─────────────────────────┐                  │
│    legal_recipients     │──────────────────┘
└──────────┬──────────────┘
           │ recipient_id
           ▼
┌─────────────────────────┐
│  legal_orders_records   │
└─────────────────────────┘
```

Files touched:
- New migration (schema + backfill + trigger + RPC update).
- `src/components/hr/payroll/LinkRecipientDialog.tsx` (authorities section, empty-state copy).
- `src/pages/hr/payroll/Garnishments.tsx` (button tooltip, badge logic).
- `docs/adr/0093-legal-recipient-master-data.md` (new section).

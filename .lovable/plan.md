## Legal Orders subsystem — closure + recipient-link bug

### 1. Close the roadmap
Confirmed: Phases 1–8 are genuinely complete (recipient master data, FSM guards, jurisdiction packs, remittance cycle, audit projection, ADRs 0092–0097, platform statutory-report seeds). No open items remain in `.lovable/plan.md`. Nothing further to build on the roadmap itself — close it.

### 2. Root-cause of the "Search contacts" empty list

The dialog issue you are seeing is **a real bug, not a data problem**. Independent verification:

- The tenant (`org 8e68…c28b`) does have contacts — 1 row (`type='customer'`) — so the list should not be empty.
- `LinkRecipientDialog.tsx` line 79 selects `id,name,email,phone,country,contact_type` from `contacts`. The `contacts` table has no column named `contact_type` — the real column is `type`.
- PostgREST rejects the select; react-query catches the error and `data ?? []` collapses to `[]`, which renders the "No contacts match…" empty state. So the list is empty for **every** tenant, not just this one — regardless of how many contacts exist.

### 3. On "the employee already has issuing authority set" — is a Contact even the right thing to link?

They are two different concepts and today the UI conflates them:

- `legal_order_authorities` = **issuing body** (Nairobi Civil Court, KRA, a SACCO's board). It carries its own `default_payee_bank / _account / _reference_template` and jurisdiction — but no `contact_id`.
- `legal_recipients` = **who receives the remittance money** (could be the court itself, a SACCO, a custodial parent's agent, a collection agency). The remittance pipeline (bank-file generation, AP settlement, statements) needs a `legal_recipients` row and it currently requires a linked `contact_id` because bank-file/AP posting flows through Contacts.

So for the Joy Matilda order:
- The authority (Nairobi Civil Court) is set — good; that is the court that issued the order.
- The order still has no `recipient_id`, because we have not told the system **where the money goes**. In many child-support cases the money goes to the same court's trust account — but nothing in the schema currently lets the authority double as the recipient without a Contact.

That is a real UX gap on top of the bug.

### 4. Fix scope

Two changes, both scoped to this dialog + one small RPC. No roadmap re-opening.

**A. Fix the broken select (blocking bug).**
In `src/components/hr/payroll/LinkRecipientDialog.tsx`:
- Replace `contact_type` with `type` in the `.select(...)` string.
- Update the `ContactRow` interface field `contact_type` → `type` and the JSX badge that renders it.
- Optional polish: also search by `email` (`.or('name.ilike.%q%,email.ilike.%q%')`) so users can find a court by its email when the display name is inconsistent.

**B. Let the issuing authority act as the recipient (closes the UX gap you spotted).**

Add a second action in the Garnishments row badge menu, next to "Link to Contact":

- Label: **"Use issuing authority as recipient"** — only enabled when `authority_id IS NOT NULL` and `recipient_id IS NULL`.
- Calls a new security-definer RPC `legal_order_use_authority_as_recipient(p_order_id uuid)` that:
  1. Loads the order + its authority in the caller's org (org-scope guard identical to `legal_order_attach_contact`).
  2. Finds an existing `legal_recipients` row for that `authority_id` with no `contact_id`, or inserts one, copying `display_name`, `jurisdiction_country/region`, `contact_email/phone`, `address`, `default_payee_*`, and `remittance_schedule_ref` from `legal_order_authorities`.
  3. Stamps `legal_orders_records.recipient_id`.
  4. Emits the existing `legal_order.recipient_attached` outbox event so audit + projections stay consistent.
- Same MERGE_REQUIRED guard as `legal_order_attach_contact` if a recipient with a linked contact already exists for that authority — force explicit choice.
- Bank-file / AP path continues to require a Contact; the recipient row without `contact_id` is fine for statement + accrual but the existing bank-file guard will refuse to generate a payout until a Contact is linked. No change there — that guard already exists and is correct.

### 5. Verification after implementation

- Reload Garnishments for this tenant; click "recipient not linked", see the 1 existing contact appear in the list.
- On the same order, use the new "Use issuing authority as recipient" action; confirm `recipient_id` is set on `legal_orders_records`, a `legal_recipients` row is created from Nairobi Civil Court, and the audit timeline shows a `recipient_attached` event.
- Attempt to generate a bank file for that recipient without a Contact and confirm the existing guard blocks it with a clear message.

### Files touched

- `src/components/hr/payroll/LinkRecipientDialog.tsx` — column-name fix, type/badge rename, optional email search.
- `src/pages/hr/payroll/Garnishments.tsx` — add the "Use issuing authority as recipient" action next to the existing badge trigger; enable only when `authority_id` present and `recipient_id` null.
- New migration adding `public.legal_order_use_authority_as_recipient(uuid)` RPC (security definer, org-scoped, outbox event emitted).
- No changes to the audit projection or ADRs; the new RPC reuses the existing `legal_order.recipient_attached` contract in ADR-0094.

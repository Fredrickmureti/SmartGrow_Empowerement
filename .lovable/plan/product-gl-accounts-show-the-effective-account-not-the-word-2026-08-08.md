# Product GL accounts: show the *effective* account, not the word "default"

## Verdict — what is actually wrong

I read the create-product form (`src/pages/inventory/ProductForm.tsx` lines 963–1010), the selector it uses (`src/components/products/ProductAccountSelector.tsx`), the client resolver (`src/lib/resolveProductAccounts.ts`), the defaults hook (`src/hooks/useDefaultAccounts.ts`) and the SQL posting paths. Four real defects, in severity order:

**1. The UI hides the posting outcome (the thing you spotted).**
`ProductAccountSelector` renders a placeholder string `"Use system default"` and a `<SelectItem value="none">Use system default</SelectItem>`. It never loads `default_account_settings`, so it literally cannot name the account. The user is asked to accept a GL posting rule they are not allowed to see. No enterprise ledger does this — Odoo shows the inherited account inline (greyed, with the category/company as the source), NetSuite and Oracle Fusion show the derived account plus a "derived from" source label.

**2. Silent unmapped defaults.**
If the org has no `sales_revenue` / `cogs` / `inventory` / `operating_expenses` mapping, the form still cheerfully says "Use system default". The failure surfaces much later, at posting time, as `Auto-posting requires Accounts Receivable and Sales Revenue default accounts`. The error is raised hundreds of steps away from the decision that caused it.

**3. No category tier — the tier Odoo actually relies on.**
`product_categories` (migration `20260208225151`) has no account columns. So the ladder is only *product override → company default*. Every deviation (e.g. "Beverages revenue" vs "Hardware revenue") has to be re-keyed on every single product. That is the main scaling failure of this design.

**4. Two ladders that can disagree.**
`resolveLineAccounts` / `resolveBillLineAccounts` (TypeScript) and `_resolve_invoice_gl_accounts` + inline `COALESCE(p.sales_account_id, v_rev_default)` (SQL) each implement the fallback independently, and older migrations (`20260213084325`, `20260413031122`) resolve by account *code/type lookup* instead of `default_account_settings`. Three sources of truth for one decision.

## What we build

### Phase 1 — Make the default visible and honest (the ask)

Rewrite `ProductAccountSelector` into an inheritance-aware field:

- Load the effective default for the field via `useDefaultAccounts()`, keyed by a new required prop `defaultKey` (`sales_revenue` | `operating_expenses` | `cogs` | `inventory`).
- Trigger label when no override is set: `4000 — Sales Revenue` rendered in muted text, with an `Inherited` badge. Not the bare phrase "Use system default".
- The reset item at the top of the list reads `Use system default (4000 — Sales Revenue)`.
- When an override *is* set, show a small `Override` badge and a `Reset to default` affordance.
- When the default is unmapped: amber `Not configured` state, copy `No system default mapped — postings for this item will fail`, and a link to Settings → Default accounts. Non-blocking (product creation still allowed), consistent with the rest of the app's "surface a CTA, never guess" rule already documented in `useDefaultAccounts`.
- Same treatment automatically benefits `ContactRecordForm` (AR / AP / expense defaults), which uses the same component.

Also fix `AccountingTab` (`src/components/products/detail/tabs/AccountingTab.tsx`): today it prints a raw UUID when the account is missing from cache and `—` when inherited. It should print the inherited account with the `Inherited` badge, matching the form.

### Phase 2 — Category-level accounts (Odoo parity)

- Migration: add `sales_account_id`, `purchase_account_id`, `cogs_account_id`, `inventory_account_id` to `public.product_categories` (nullable FKs to `accounts`), with grants unchanged for the existing roles.
- Ladder becomes: **line override → product → product category (walking `parent_id` upward) → company default**.
- Category editor gets the same inheritance-aware selector.
- Product form's inherited value then shows the category account when one exists, labelled `From category "Beverages"` instead of `System default`.

### Phase 3 — One resolver, one ladder

- Single SQL function `resolve_product_gl_account(org, business, product_id, purpose)` implementing the ladder, used by every posting path; the TypeScript helpers in `src/lib/resolveProductAccounts.ts` delegate to a mirrored implementation and are covered by a parity test (same pattern as the identity resolver in ADR 0114).
- Remove the code/type-based account lookups in the legacy migrations in favour of `get_default_account_id`.
- Architecture guard: no component may render the literal string "Use system default" outside the shared selector.

## Technical notes

- Files touched in Phase 1: `src/components/products/ProductAccountSelector.tsx` (rewrite), `src/pages/inventory/ProductForm.tsx` (pass `defaultKey`), `src/features/contacts/ContactRecordForm.tsx` (pass `defaultKey`), `src/components/products/detail/tabs/AccountingTab.tsx`.
- Phase 1 is presentation-only: no change to how postings resolve, only to what the operator is shown.
- Phases 2 and 3 change the ledger's resolution behaviour and get their own ADR (`docs/adr/`) plus SQL tests under `supabase/tests/`.

## Suggested sequencing

Phase 1 now (it is the reported defect and is safe). Phases 2 and 3 next, in that order — Phase 3 is only worth doing once the category tier exists, otherwise we would unify a ladder we are about to change.

# Product GL account inheritance ladder — status

Ladder (ADR 0122, `docs/adr/0122-product-gl-account-inheritance-ladder.md`):

```text
line override  ->  product  ->  product category (nearest ancestor)  ->  company default
```

Bill/purchase paths add a vendor tier between category and company default.

## Complete

- **P0 — crash fix.** `ProductAccountSelector` (and three other SPA
  components) rendered a TanStack `Link` inside the react-router-dom tree,
  crashing the product form when Type = Product. Guard:
  `src/test/architecture/no-tanstack-router-in-spa.test.ts`.
- **P0 — SQL resolvers.** `resolve_product_gl_account` /
  `resolve_product_account_override` + delivery COGS, recurring invoices and
  `confirm_bill_atomic` on the ladder.
- **P1 item 1 — stock adjustments / opening stock** resolved per line, journal
  lines grouped per resolved account.
- **P1 item 2 — POS statement posting.** `post_pos_statement_gl` now splits
  net revenue across ladder-resolved accounts (statement totals stay
  authoritative; residual lands on the last bucket) **and posts COGS +
  inventory relief** per resolved account pair for stock-tracked items.
  Previously POS recognised revenue but never reduced inventory value or
  recognised cost, overstating both stock on hand and gross profit. Returns
  carry a -1 multiplier; the COGS block is skipped when the company
  `cogs`/`inventory` defaults are unmapped so existing closes cannot start
  failing. Guard: `src/test/architecture/pos-statement-account-ladder.test.ts`.
- **P2 — purchases-side UI parity.** New
  `src/components/documents/lines/LineAccountCell.tsx` shows each bill line's
  *effective* GL account plus the tier it came from (Override / From product /
  From category "…" / From vendor / Default), with change + reset, and an amber
  warning when nothing is mapped. Wired into `BillCreatePage` and
  `BillEditPage` (vendor tier fed by `fetchContactDefaults`). Purchase orders
  are out of scope: `purchase_order_items` has no account column and POs do not
  post to the ledger. Guard:
  `src/test/architecture/bill-line-account-visibility.test.ts`.
- **P3 — architecture guard.**
  `src/test/architecture/posting-paths-no-direct-product-accounts.test.ts`
  asserts the posting functions delegate to the ladder resolver and never read
  `products.*_account_id` directly or resolve accounts by `detail_type`.
- **P4 — the last ladder tier actually resolves (this turn).** The product form
  showed *"No system default mapped — postings that rely on this account will
  fail"* for the purchase/expense account. Root cause was **architectural, not
  UI**: `provision_missing_system_accounts` skips a role when *any* account of
  a compatible shape exists (`status = 'already_eligible'`), so the role was
  never stamped on an account and never written to `default_account_settings`.
  26 non-payroll roles were unmapped, including `operating_expenses`,
  `service_revenue`, `sales_returns`, `purchase_returns`, `discount_given/
  received`, `bank_fees`, `rounding_gain/loss`, `clearing_pos`, `suspense`,
  `credit_card_clearing`, `mobile_money`.
  Fix (Odoo/Oracle chart-template parity — a template must *guarantee* every
  property account resolves):
  - New `public.ensure_default_account_mappings(org, business)` — for every
    template-backed role (excluding `category = 'payroll'`, owned by the
    country payroll packs) it reuses the role-bearing account, else adopts /
    creates the standard account via the allowlisted `upsert_system_account`,
    then writes the `default_account_settings` row. Idempotent.
  - Wired into `provision_default_chart_of_accounts`, so new companies are
    complete on day one, and back-filled across all existing businesses.
  - Verified: all 14 previously-unmapped commerce roles now resolve;
    `operating_expenses -> 6010-SYS Operating Expenses` (code suffixed because
    `6010` was already taken by a legacy "Salaries and Wages" row).
  - Guards: `src/test/architecture/default-account-role-coverage.test.ts` and
    `supabase/tests/default_account_role_coverage_test.sql` (fails if any
    non-payroll template-backed role is unmapped for any business).

Verification: `tsgo --noEmit` clean; ladder / parity / SPA / role-coverage
guard tests green.

## Currently active phase

P4 is complete. No phase is mid-flight.

## Remaining / optional follow-ups (next phase = item 1)

1. **Next milestone — category editor parity.** The product-category form should
   show the same inheritance badges (`Override` / `From category "…"` /
   `Default`) as the product form, using `ProductAccountSelector` +
   `useCategoryAccounts`.
2. Extend the P3 guard's function list as more posting paths migrate
   (`_resolve_invoice_gl_accounts`, `confirm_bill_atomic`,
   `complete_delivery_atomic` still contain legacy inline `COALESCE` forms in
   older migrations).
3. Cosmetic: legacy account `6010 "Salaries and Wages"` collides with the
   standard Operating Expenses code, forcing `6010-SYS`. Consider a data-hygiene
   pass that renumbers the legacy row.
4. Backfill consideration: POS statements closed before P1 item 2 have no
   COGS/inventory entry. Decide whether to post a one-off catch-up journal or
   leave history untouched (postings store resolved account ids, so history is
   internally consistent either way).

## Instructions for the next agent

1. **Verify first, then continue.** Confirm P4 holds: run
   `bunx vitest run src/test/architecture` and query
   `default_account_settings` for any non-payroll template-backed role without
   a mapping (the SQL test above encodes the check). Also confirm the product
   form no longer shows the "No system default mapped" warning for the
   purchase/expense account.
2. Then resume at **follow-up item 1 (category editor parity)** — do not jump to
   unrelated modules, and finish that phase to production quality (UI + guard +
   plan update) before moving on.


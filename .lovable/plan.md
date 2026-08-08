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

Verification: `tsgo --noEmit` clean; 32 ladder / parity / SPA guard tests green.

## Remaining / optional follow-ups

1. Extend the P3 guard's function list as more posting paths migrate
   (`_resolve_invoice_gl_accounts`, `confirm_bill_atomic`,
   `complete_delivery_atomic` still contain legacy inline `COALESCE` forms in
   older migrations).
2. Category editor parity — the category form should show the same inheritance
   badges as the product form.
3. Backfill consideration: POS statements closed before this change have no
   COGS/inventory entry. Decide whether to post a one-off catch-up journal or
   leave history untouched (postings store resolved account ids, so history is
   internally consistent either way).

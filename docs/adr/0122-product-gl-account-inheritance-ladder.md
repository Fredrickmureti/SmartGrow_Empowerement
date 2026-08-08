# ADR 0122 — Product GL account inheritance ladder

Status: Accepted

## Context

The product form exposed four "Default GL accounts" selectors that rendered
"Use system default" with no indication of which account would actually be
used. Users could not tell what a sale, purchase, or delivery would post to
without leaving the screen. Two further problems sat underneath the UI:

1. Resolution logic was duplicated between TypeScript helpers and SQL posting
   functions, free to drift.
2. There was no category tier. Every product needed a manual override to
   deviate from the company default — Odoo, NetSuite and Oracle all resolve
   through a product-category tier precisely to avoid this.

## Decision

### 1. One ladder, four tiers

```text
line override  ->  product  ->  product category (nearest ancestor)  ->  company default
```

Category inheritance walks `product_categories.parent_id` upward and takes the
first ancestor that defines the account. The walk is cycle-safe and depth
bounded.

### 2. Effective account is always visible

`ProductAccountSelector` never shows a bare "Use system default". It shows the
resolved account (`4000 — Sales Revenue`) plus a badge naming the tier it came
from (`Default`, `From category "Hardware"`, `Override`), a reset action, and
an amber warning linking to Finance → Settings when no tier supplies an
account.

### 3. Single canonical resolver in SQL

`public.resolve_product_gl_account(org, business, product_id, purpose)`
implements the product → category → company tiers server-side.
`purpose` is one of `sales_revenue | purchase_expense | cogs | inventory`;
anything else raises. It is `STABLE SECURITY DEFINER`, executable by
`authenticated` and `service_role` only.

`src/lib/resolveProductAccounts.ts` is the client mirror used for pre-posting
previews and for building JE lines client-side. Its tier order must match the
SQL function exactly; `src/test/architecture/product-gl-account-ladder.test.ts`
enforces that.

### 4. Reversal symmetry

A reversal MUST resolve accounts through the same ladder as the posting it
reverses. Picking an account by `detail_type` (`LIMIT 1`) or reversing a
per-product posting into a single company-level account leaves permanent
per-account drift even when the totals net to zero.

- `approve_sales_return_atomic` delegates to
  `resolve_sales_return_cogs_lines`, the mirror of
  `resolve_delivery_cogs_lines`: inventory/COGS lines are grouped by the
  ladder-resolved account pair per return line.
- `issue_credit_note_atomic` delegates to
  `resolve_credit_note_revenue_lines`, which splits the revenue debit across
  the revenue accounts the sale credited, weighted by line total. The header
  subtotal is authoritative and any rounding residual lands on the last
  bucket, so the JE always balances.

Both resolvers keep a company-level fallback (`detail_type` for
inventory/COGS, `compensation_account` for revenue) used only when no tier
supplies an account, so orgs with no product or category mapping behave
exactly as before.
`src/test/architecture/posting-paths-no-direct-product-accounts.test.ts`
guards the delegation.


- `product_categories` carries `sales_account_id`, `purchase_account_id`,
  `cogs_account_id`, `inventory_account_id`, all nullable = inherit.
- `_resolve_invoice_gl_accounts` delegates per-product revenue to the canonical
  function. Remaining SQL posting paths (delivery COGS, bill expense, POS)
  still inline `COALESCE(product.x, default)`; migrating them is a follow-up
  and is safe because the inline form is the ladder minus the category tier.
- Changing a category's account changes future postings for every product
  inheriting it. Historical journal entries are untouched — postings store the
  resolved account id.

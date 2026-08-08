# Product GL accounts — verification verdict and remaining phases

Ladder (ADR 0122): `line override -> product -> product category (nearest ancestor) -> company default`
(bills add a vendor tier between category and company default).

## Phase 1 — verification of the previous engineer's claims

Checked against the codebase and the live database, not the log.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| SQL resolvers exist | Confirmed | `resolve_product_gl_account`, `resolve_product_account_override`, `ensure_default_account_mappings`, `provision_default_chart_of_accounts` all present |
| Invoice revenue on the ladder | Confirmed | `_resolve_invoice_gl_accounts` calls the resolver |
| Delivery COGS on the ladder | Confirmed | `complete_delivery_atomic` delegates to `resolve_delivery_cogs_lines`, which resolves per line |
| Bills on the ladder | Confirmed | `confirm_bill_atomic` uses `resolve_product_account_override` |
| POS statement revenue + COGS/inventory | Confirmed | `post_pos_statement_gl` uses the override resolver |
| Stock adjustments / opening stock | Confirmed | `post_stock_adjustment_gl` uses the resolver |
| Category tier columns | Confirmed | `product_categories` carries the four nullable account columns |
| Effective-account UI (product + bill lines) | Confirmed | `ProductAccountSelector` shows resolved account + tier badge + reset + amber unmapped warning; `LineAccountCell` does the same per bill line |
| "Remaining item 1 — category editor parity" | **Already implemented, plan was stale** | `ProductCategoriesManager` renders all four `ProductAccountSelector` fields with parent-category inheritance via `resolveCategoryAccount`, and persists them on create/update |

Not verifiable this turn: the vitest suite cannot run because dev dependencies
are not installed in this sandbox (`Cannot find package 'vitest'`). Test files
for every claimed guard exist. Re-running them is step 0 of implementation.

### New defects found (not in the previous plan)

Both are ladder gaps on the **reversal** side, which is exactly where the
parent brief warned that asymmetry corrupts reporting.

1. **P0 — sales returns bypass the ladder.** `approve_sales_return_atomic`
   picks its inventory and COGS accounts with
   `SELECT id FROM accounts WHERE detail_type = 'inventory' / 'cost_of_goods_sold' ... LIMIT 1`.
   That is the "resolve by detail_type" smell the P3 guard was written to
   forbid, and it is non-deterministic when a company has more than one
   account of that detail type. A product whose COGS/inventory came from a
   product override or category tier at delivery time is returned into
   different accounts, so inventory and COGS never net back to zero.
2. **P0 — credit notes reverse revenue to a single company account.**
   `issue_credit_note_atomic` debits `compensation_account(business, 'sales_revenue')`
   for the whole subtotal, while the original invoice credited revenue
   per-product through `_resolve_invoice_gl_accounts`. Crediting a product
   whose revenue resolves to a non-default account moves money between revenue
   accounts. Revenue-by-account reporting drifts by exactly the credited
   amount.

Historical integrity itself is sound: every posting stores the resolved
account id, so changing a default only affects future postings. That part of
the architecture needs no change.

## Phase 2 — remaining plan

### P0 — accounting correctness

1. **Sales-return ladder.** Rewrite the inventory/COGS block of
   `approve_sales_return_atomic` to resolve per return line via the same
   resolver `resolve_delivery_cogs_lines` uses, and emit one JE line pair per
   resolved account pair (mirroring the delivery COGS shape) instead of one
   lump pair. Keep the existing "skip when unmapped / period closed" guard so
   no currently-working flow starts failing.
2. **Credit-note revenue ladder.** Split the revenue debit in
   `issue_credit_note_atomic` across ladder-resolved accounts per credit-note
   line, with the header subtotal authoritative and any rounding residual
   landing on the last bucket — the same rule `post_pos_statement_gl` already
   uses. Fall back to the company `sales_revenue` account when a credit note
   has no product-linked lines.

### P1 — domain architecture

3. Extend `posting-paths-no-direct-product-accounts.test.ts` to cover
   `approve_sales_return_atomic` and `issue_credit_note_atomic`, so the
   detail-type lookup cannot come back.
4. Sweep the remaining GL-posting functions for inline `COALESCE(product.x,
   default)` forms and list them in the ADR as either migrated or explicitly
   out of scope (POs do not post; `post_pos_sale_gl` is legacy).

### P2 — user experience

5. Category-editor parity is done; add the missing guard test asserting
   `ProductCategoriesManager` renders all four inheritance-aware selectors and
   persists nulls as inheritance.
6. Vendor credit notes (`issue_vendor_credit_note_atomic`) get the same
   effective-account treatment as bills once item 2 lands.

### P3 — hardening

7. Update ADR 0122 with the returns/credit-note tiers and the reversal-symmetry
   rule: *a reversal must resolve through the same ladder as the posting it
   reverses.*
8. Data hygiene: legacy account `6010 "Salaries and Wages"` forces the standard
   Operating Expenses code to `6010-SYS`; renumber the legacy row.
9. Decide on POS statements closed before COGS posting existed — catch-up
   journal or leave history untouched (history is internally consistent either
   way).

### Verdict on the parent brief's question

The UI issue was real but secondary: it is now **B → resolved** (effective
account plus tier is shown on products, categories, and bill lines). The
underlying architecture is **partially correct** — the forward ladder is
coherent and historically safe, but the reversal paths (returns, credit notes)
are still off-ladder, which is a P0 accounting defect, not a UX one.

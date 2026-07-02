# Multi-Entity Architecture

This system uses an Odoo-aligned three-tier model. The boundaries are
**enforced at the database level** by triggers and FKs. They are not
suggestions — violating them will fail to commit.

## The three tiers

| Tier | Table | Role | Identity? |
|---|---|---|---|
| Workspace | `organizations` | Tenant / billing / subscription / users | **No** |
| Company | `businesses` | Legal entity / accounting boundary | **Yes** |
| Branch | `branches` | Physical/logical location within a company | No |

### `organizations` — workspace chrome only
Holds: name, slug, logo, subscription, owner.
Does **NOT** hold: currency, tax id, address, country, email, phone,
invoice prefix, legal name. These columns intentionally do not exist.

### `businesses` — the legal entity
The accounting boundary. Owns the chart of accounts, fiscal periods,
journal entries, base currency, tax id, address, and every document
identity field. One workspace can host many companies (e.g., a holding
group with subsidiaries in different countries).

### `branches` — locations
Belong to a company, never directly to a workspace.
Exactly one branch per company is the headquarters
(enforced by `branches_one_hq_per_business` unique partial index).

## Frontend rules

1. **Documents (invoices, bills, statements, receipts, PDFs, emails) MUST
   read identity from `useDocumentBranding(record.business_id)`** — not
   from `currentOrg`, not from `currentBusiness`. The record's own
   `business_id` is the source of truth, because the user may have
   switched companies after the record was created.

2. **Operational forms (creating a new bank account, RFQ, payroll,
   migration step) MUST read identity from
   `useBusinesses().currentBusiness`** — never from `currentOrg`.

3. **`currentOrg` is allowed only for tenant chrome**: sidebar logo,
   workspace name in the header, settings page editing the org itself.
   The architecture test `no-org-identity-reads.test.ts` enforces this.

4. **No silent currency fallbacks.** If no business is selected, do not
   default to `"USD"` or any other code — block the operation.

## Database guarantees (selection)

- Journal entries can never cross companies (`enforce_je_line_company_match`).
- A payment's company must match its invoice's company
  (`trg_payment_invoice_business_match`); same for bill payments,
  depreciation entries, asset maintenance, analytic distributions.
- A business's `base_currency` is immutable once any JE exists
  (`lock_business_currency_after_je`).
- Posted journal entries are immutable; only void/reverse permitted.
- An organization cannot lose its last business
  (`prevent_last_business_removal`).
- Every branch's organization must equal its company's organization
  (`enforce_branch_org_consistency`).
- Roles live in a separate `user_roles` table accessed via the
  `has_role()` SECURITY DEFINER function — never on the profile.

## What lives where (cheat sheet)

| Concern | Belongs on |
|---|---|
| Subscription, plan, trial, suspension | `organizations` |
| Workspace logo (sidebar chrome) | `organizations.logo_url` |
| Currency, country, tax id, legal name, addresses | `businesses` |
| Document logo, invoice prefix | `businesses` |
| Chart of accounts, fiscal periods, journal entries | `businesses` |
| Tax rates, payroll structures, fixed assets, analytic accounts | `businesses` |
| Bank accounts | `businesses` (via `business_id NOT NULL`) |
| User permissions and roles | `organizations` (workspace-level) |

## Inter-company transactions

Not modeled in v1. A workspace with multiple companies can run them in
parallel but there is no automatic mirroring of an AR invoice in
Company A into an AP bill in Company B. If you need this, model it
explicitly — do not silently share rows across companies.

## Inventory scoping (Phase A–G hardening)

Inventory follows the same three-tier model, but with a tighter
operational boundary:

| Concept | Scope | Notes |
|---|---|---|
| `products` | company (`business_id`) | One row per SKU per company. `stock_quantity` is a **deprecated company-aggregate** maintained by trigger for legacy reads only — **never use it as a decision input** (low-stock, replenishment, POS availability, reservations, valuation). Read `warehouse_stock` filtered by `(business_id, branch_id)` instead. The `inventory-branch-filter.test.ts` and `pg_get_functiondef` snapshot tests guard against regressions. Stage C atomic RPCs (`complete_goods_receipt_atomic`, `complete_delivery_atomic`) replace JS loops and post GL inside the same transaction. `stock_movements` carries `lot_number`/`serial_number` for traceability and `business_id` is `NOT NULL` (orphaned legacy rows quarantined into `stock_movements_orphans`). |
| `warehouses` | (company, branch) — both NOT NULL | A warehouse lives at exactly one branch. `UNIQUE (business_id, code)` so two companies can both have a "MAIN". |
| `warehouse_stock` | (warehouse → company, branch) — both NOT NULL | Per-(warehouse, product) on-hand + reserved. Stamped from the warehouse by the `update_product_stock` trigger. The single source of truth for "is there stock?". Low/out-of-stock alerts are evaluated from this table, not from `products.stock_quantity`. |
| `stock_movements` | (warehouse → company, branch) — both NOT NULL | Every insert MUST carry `business_id` and `warehouse_id`. The trigger derives `branch_id` from the warehouse but cannot derive business. Enforced by the `stock-movement-scope.test.ts` architecture test. |
| `stock_transfers` | company; with `from_branch_id`/`to_branch_id` | Two-step: approval = dispatch (source → in-transit), completion = receive (in-transit → destination). Cancellation reverses dispatched legs. |
| `product_reorder_rules` | company; optional `branch_id` | NULL `branch_id` = company-wide rule; non-null = branch override. Use `pickEffective` from `lib/branchScoped.ts` to resolve. |
| `accounts` | company | No per-branch CoA. Branches inherit. |

Direct Sales invoices use `confirm_invoice_and_release_stock_atomic` by
default. The RPC confirms Revenue/AR, creates the auto Delivery Note for
stockable lines, and immediately completes that delivery so stock decreases via
traceable `stock_movements`. Users may still confirm without release only when
they intentionally want pending delivery; stock is never changed by directly
editing product totals.

### In-transit pseudo-warehouse

Each company has a virtual warehouse marked `is_in_transit = true`,
created lazily by `get_or_create_in_transit_warehouse(business_id)`.
It holds stock that has been dispatched but not yet received. The
operational `useWarehouses` query excludes it; transit-aware reports
can read it directly. This keeps stock totals truthful during the
window between dispatch and receipt.

### UI guard rails

- `CompanyScopeGate` — wraps every report; forces single-company view
  in multi-company workspaces.
- `BranchScopeGate` — wraps inventory reports; in multi-branch
  companies forces the operator to pick a branch instead of silently
  aggregating.
- `ActiveBranchBadge` — always visible on inventory pages so the
  operator can see which branch they're acting on (hidden for
  single-branch companies).
- `BranchScopeToggle` (inside reports) — explicit "this branch" vs
  "all branches in this company" affordance.

### Database guard rails (selection)

- `enforce_stock_movement_branch_scope` — rejects movements whose
  `business_id`/`branch_id` don't match the warehouse.
- `enforce_stock_transfer_branches_match` — both branches must belong
  to the transfer's company.
- `approve_stock_adjustment_atomic` — picks GL accounts by both
  `organization_id` AND `business_id`. Raises if missing rather than
  silently no-op.
- `reserve_stock` / `release_stock` — require and validate company
  match against the warehouse.
- Architecture tests `inventory-branch-filter.test.ts` and
  `stock-movement-scope.test.ts` fail CI on regressions.

### In-transit branch attribution (intentional)

During a stock transfer, the in-transit leg's `stock_movements.branch_id` is
stamped to the **source** branch (`from_branch_id`) — including the
receive-out-of-transit leg in `complete_stock_transfer_atomic`. This is
intentional: per-branch reporting attributes the cost of in-transit goods to
the originating branch (matching Odoo's "transit cost stays with the source
company" rule). The destination leg only is stamped with `to_branch_id`.

Do not "fix" this by re-stamping the in-transit leg to the destination —
it would double-count the goods in destination reports during the transit
window and break per-branch in-transit aging.

### Opening balances and per-warehouse reorder rules

- **Opening stock** for a (warehouse, product) MUST be recorded via the
  `record_opening_stock(business_id, warehouse_id, items, user_id)` RPC.
  The RPC creates a `stock_adjustments` header (`reason='opening_balance'`),
  inserts proper `stock_movements` (which the trigger applies to
  `warehouse_stock`), and posts a journal entry **DR Inventory / CR Opening
  Balance Equity** in the company's CoA. Direct writes to
  `products.stock_quantity` are blocked by the
  `guard_products_stock_quantity` trigger and by the
  `no-direct-stock-aggregate-writes.test.ts` architecture test.
- **Reorder thresholds** are per-warehouse: edit them on
  `warehouse_stock.reorder_level` / `reorder_quantity` in the warehouse
  stock drawer. `products.reorder_level` survives only as a *seed default*
  used when a new `warehouse_stock` row is created — it is never read at
  runtime for low-stock decisions.

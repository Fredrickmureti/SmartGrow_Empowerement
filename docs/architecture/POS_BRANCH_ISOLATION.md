# POS Branch Isolation

Status: **Active** (Wave D shipped 2026-05-16). This document is the
single source of truth for how the POS module separates operational
context between branches, and what the rules are when HQ supervises
multiple branches at once.

## 1. Mental model — shared ledger, branched mappings

Mature multi-branch ERP/POS systems converge on one principle:

> The **chart of accounts** is shared across branches (one ledger per
> company). What's **branch-overridable** is the *mapping* from a
> business event to a specific account, plus *operational policies*
> like PIN ceilings and payment-method availability.

Mapping in the wild:

| Platform | Pattern |
|---|---|
| Odoo 17 Accounting (Branch addon) | per-branch default account overrides; account itself is shared |
| NetSuite OneWorld | "subsidiary-specific account mapping" with optional restrict-to-subsidiary flag on the account |
| SAP Business One Branches | GL determination rows carry `BPLId`; posting picks most-specific match |
| Lightspeed X-Series / Shopify POS Plus | per-location "GL mapping override" with fallback to org default |

We follow the same shape:

```text
┌────────────────────────────────────────┐
│  accounts          (shared per company)│  ← chart of accounts
└────────────────────────────────────────┘
        ▲
        │ referenced by
        │
┌────────────────────────────────────────┐
│  default_accounts                      │
│  (organization_id, business_id,        │  inherit-with-override:
│   purpose, account_id, branch_id NULL) │  branch row wins over
└────────────────────────────────────────┘  company default row
        ▲
        │ resolved by
        │
   public.resolve_default_account(
     p_business_id, p_purpose, p_branch_id
   )  RETURNS uuid
```

The same pattern applies to `default_account_settings`,
`pos_security_settings`, and `pos_payment_methods` — each carries an
optional `branch_id` and is resolved per document.

## 2. Visibility vs mutation — the foundational rule

**Visibility ≠ mutation authority.** HQ overseers (owner / admin /
super_admin with no active branch) may *see* registers, shifts,
sessions, and transactions across all branches as a read-only
supervision lens. They may not *mutate* without first switching their
active branch context to the entity's owning branch.

Enforced at three layers:

1. **RLS SELECT policies** — relaxed for overseers in HQ mode (via
   `can_access_branch` + role gating).
2. **DB triggers** (`tg_assert_pos_branch_caller_access` on every
   money-handling table) — block any INSERT/UPDATE/DELETE whose
   target row's `branch_id` doesn't match the caller's active branch.
3. **Client-side guards** — every UPDATE on `pos_transactions` is
   bound with `.eq("branch_id", …)` so a context-switch race fails
   fast with a 0-row result, never silently producing a 42501.

## 3. Realtime channel scoping

`useLazyRealtimeSync` keys POS-table channel topics by
`(org_id, branch_id)`. Branch-scoped tables refuse to subscribe
without an active branch. Payloads whose `branch_id` doesn't match
are dropped before React Query is invalidated — preventing
cross-branch cache invalidations as a side channel.

Branch-scoped tables (see `POS_BRANCH_SCOPED_TABLES`):
`pos_transactions`, `pos_shifts`, `pos_held_transactions`,
`pos_kitchen_orders`, `pos_drawer_events`, `pos_cash_movements`.

## 4. Concurrency guards

- `uq_pos_shifts_one_open_per_register` — partial unique index
  prevents a context-switch race from opening parallel shifts on the
  same register.
- `uq_pos_shifts_one_open_per_cashier` — analogous for cashiers.
- `pos_transactions.version` + branch-bound UPDATE — optimistic
  concurrency for restaurant table orders.

## 5. Operational rules for users

| Action | Required context |
|---|---|
| Open a till on register R | Active branch must equal R's branch |
| Void / refund a transaction | Active branch must equal the transaction's branch |
| Set a per-branch GL mapping override | Admin role + `can_access_branch(branch)` |
| Set the company-default GL mapping | Admin role at organization scope |
| Wipe POS data (POSDataResetTool) | HQ-overseer mode only (no active branch) |

## 6. Resolver contract — for new code

- Picking a GL account for posting → `resolveDefaultAccount(business_id, purpose, document_branch_id)`. Never `select account_id from default_accounts` directly.
- Reading POS security thresholds → `usePOSSecuritySettings()` (uses the branch-aware resolver under the hood).
- Reading available payment methods → `usePOSSettings()` returns deduped methods (branch row wins).

The `branch_id` you pass is **the document's** branch, not the
operator's current UI branch. A sales invoice raised on Branch A
must resolve A's overrides even if the operator is now in B.

## 7. Non-goals

- Per-branch chart of accounts. Accounts stay shared per company.
- Inter-branch transfers / inter-company eliminations (separate
  workstream — handled at the finance layer, not POS).
- Re-platforming realtime to Phoenix presence (channel scoping by
  `(org, branch)` is sufficient).

## 8. Open follow-ups

- Backfill for historical `pos_transactions` rows with `branch_id = NULL`
  (HQ-captured before isolation landed). Pending an operational
  decision: attribute to a default branch / register's current branch /
  quarantine into a reconciliation queue.
- `FinanceSettings → Default accounts` UI for branch-override toggles
  (DB layer ready; UI lands once `src/integrations/supabase/types.ts`
  is regenerated with the new `branch_id` columns).
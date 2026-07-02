# Purchases Module — Final Audit Verdict

Date: 2026-05-03
Scope: end-to-end Purchases (RFQ → PO → Goods Receipt → Bill → Payment → Return → VCN → Reporting), with cross-module checks into Inventory, Finance, Contacts.

## Isolation matrix (after this turn's hardening)

| Table                  | Org RLS | Business RLS | Branch RLS | App-layer branch read | App-layer branch write |
|------------------------|:-------:|:------------:|:----------:|:---------------------:|:----------------------:|
| bills                  | ✅      | ✅           | ✅ **new** | ✅                    | ✅                     |
| bill_payments          | ✅      | ✅           | ✅ **new** | ✅ (via bill)         | ✅ (RPC `_branch_id`)  |
| purchase_orders        | ✅      | ✅           | ✅ **new** | ✅                    | ✅ (sibling-branch refused) |
| purchase_returns       | ✅      | ✅ **new**   | ✅ **new** | ✅                    | ✅                     |
| vendor_credit_notes    | ✅      | ✅ **new**   | ✅ **new** | ✅                    | ✅                     |
| rfqs                   | ✅      | ✅ **new**   | ✅ **new** | ✅                    | ✅                     |
| vendor_pricelists      | ✅      | ✅           | ✅ **new** | ✅                    | ✅                     |
| expenses               | ✅      | ✅ **new**   | n/a (no col) | n/a                  | n/a                    |
| vendor_statements      | ✅      | ✅ (existing)| —          | ✅                    | ✅                     |

`branch_id IS NULL` rows (legacy / company-shared) remain visible to all branch users — intentional, matches the `applyBranchFilter` semantics.

## What changed in this turn

1. **DB migration** — added `user_can_access_branch(uid, branch_id)` SECURITY DEFINER helper, then rewrote RLS policies on the 7 branch-bearing purchases tables to enforce `business_id` + `branch_id` + module permission. Added the missing `business_id` arm to `expenses, rfqs, purchase_returns, vendor_credit_notes`.
2. **Architecture guard** — added `src/test/architecture/purchases-branch-id-stamping.test.ts` (write-only twin of the read-side guard), so write coverage cannot regress silently.
3. **Verdict doc** — this file.

## What was already in place (re-verified, not just trusted)

- `useVendorPriceLists` — branch in queryKey + `applyBranchFilter` + branch-scoped unset-other on insert.
- `usePurchaseOrders.createPurchaseOrder` — refuses tampered `branch_id` payloads pointing at a sibling branch; overrides to `currentBranch.id`.
- `useBills.recordBillPayment` → `record_bill_payment_atomic(_branch_id := bill.branch_id)`; payment + JE rows inherit the bill's branch.
- `PurchasesDashboard` — passes `p_branch_id: currentBranch?.id ?? null` to `get_purchases_dashboard_kpis` and `get_top_vendor_spend`; surfaces a "Scope: Branch / All branches (HQ)" chip.
- `purchases-branch-scope.test.ts` (read+write combined guard) green.

## Residual risks / explicitly deferred

- **HQ "All branches" toggle on dashboard** — still a chip-only display. Switching scope is done via the workspace branch selector. A dedicated `?scope=all|current` URL toggle was discussed but is **not** implemented; deferred because the chip already prevents the misread it was meant to prevent and the workspace selector achieves the same outcome.
- **`require-branch-scope` ESLint rule** — not added. The vitest guards (`purchases-branch-scope` + `purchases-branch-id-stamping`) provide the same protection at CI time. Lint-time feedback is a UX nicety, not a correctness gap.
- **Pre-existing project build errors** — unrelated `react-router-dom` and `framer-motion` type errors across hundreds of files. Not introduced by Purchases work; out of scope for this audit.

## Sign-off

Purchases is now **DB-layer + application-layer safe** against:
- cross-organization leakage (existing org RLS),
- cross-business leakage within a workspace (business RLS now uniform),
- cross-branch leakage within a business (branch RLS + app filters + write-side stamping + arch tests).

Safe to open to multi-branch users.

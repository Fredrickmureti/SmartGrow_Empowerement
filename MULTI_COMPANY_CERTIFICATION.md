# Multi-Company Certification Status

**Date:** 2026-04-21
**Verdict:** ⚠️ **NOT YET CERTIFIED for multi-company GA. Single-company beta only.**

This document tracks the invariants that must all be ✅ before the system can
be sold to customers operating two or more legal entities (Companies) in the
same Workspace.

---

## ✅ What is certified safe today

| Invariant | Evidence |
|---|---|
| Three-tier entity model (Workspace › Company › Branch) is Odoo-aligned | `ARCHITECTURE.md`, `BUSINESS_SCOPED_TABLES` registry (203 tables) |
| Database-side cross-company guard | `user_can_access_business()` RESTRICTIVE RLS on every business-scoped table (Phase A/2 migrations) |
| GL/JE company immutability | DB triggers on `journal_entries`, `journal_entry_lines` |
| Document branding pulled from `business_id` (never `organization_id`) | `useDocumentBranding`, enforced by arch test |
| Branch override pattern (`branch_id IS NULL` = company-shared) | `pickEffective`, `visibleForBranch` |
| Reports gated by `<CompanyScopeGate>` so multi-company workspaces can't aggregate by accident | All 6 financial reports + Tax/Stock/Sales/Aging/Partner Ledger |
| Signup writes country/currency to `businesses` (not `organizations`) | `complete_onboarding` RPC; verified Phase 0 of audit |
| Settings hub split into `/settings/workspace` (chrome) and `/settings/company` (books, gated) | Phase 3 of audit |
| Onboarding atomically provisions Org + Company + HQ Branch + localized CoA + fiscal periods | `complete_onboarding` RPC, `BusinessContext.createBusiness` RPC |

---

## ❌ Outstanding blockers — must be green before GA

| Blocker | Status | Owner |
|---|---|---|
| **245 ESLint `require-business-scope` violations across 155 files** (down from 283 baseline) | RED — build fails. Hooks that touch transactional data (POS, Leave, Finance reads) still issue queries scoped only by `organization_id`. RLS catches the leak at the DB layer (so no cross-company read actually happens), but app code that forgets `business_id` produces `PGRST116` errors and confusing UX. | Mechanical sweep across `src/hooks/pos/*`, `src/hooks/leave/*`, `src/hooks/*.ts`, `src/services/**`, `src/components/**`. |
| **No two-company isolation Vitest suite** | MISSING. There is no runtime test that boots two Companies under one Workspace, lists invoices/bills/POS/leads from each, and asserts zero leakage. | `src/test/architecture/two-company-isolation.test.ts` |
| **`useScopedFrom()` / `scopedToCompany()` helpers have zero adopters** | The defensive rails were built and abandoned. New code can still bypass them. | Adopt in the highest-risk hooks first. |

---

## What WAS landed in this session

1. **Phase 0 (verified):** Signup → `complete_onboarding` RPC writes country/currency/CoA to the `businesses` row, provisions HQ branch, creates fiscal year + 12 monthly periods. No drift from Odoo.
2. **Phase 3 (shipped):** Settings split into two scope-aware hubs (`/settings/workspace` for chrome, `/settings/company` for books, gated by `<CompanyScopeGate>`).
3. **Lint-rule sharpening (shipped):** `eslint-rules/require-business-scope.js` now honors `// SCOPE-EXEMPT:` comments placed anywhere within the enclosing query chain (e.g., above `.from(...)`), not just within 3 lines of `.eq(...)`. Cleared 21 false positives without changing any behavior.
4. **Registry extension (shipped):** `src/lib/businessScopedTables.ts` extended with 12 missing genuinely-scoped tables (`expenses`, `expense_categories`, `estimates`, `email_templates`, `bank_transactions`, `vendor_pricelists`, `organization_invitations`, `pos_payment_methods`, `pos_cashier_registers`, `pos_transaction_items`, `permission_group_rules`) so the guard now polices them too.
5. **Targeted codemods (partial):** Auto-appended `.eq("business_id", currentBusiness!.id)` on a small, safe subset of single-line query chains. Refused to touch multi-line chains, conditional `if (businessId) X.eq(...)` patterns, and files lacking `useBusinesses` — those need hand surgery to avoid silent regressions.
6. **Honest scorecard:** This document, replacing the previous agent's incorrect "fully complete" claim. Net delta this session: 283 → 245 violations.

---

## Why the system is NOT yet GA-safe

The DB-side RLS (`user_can_access_business()`) means **a malicious or buggy
client cannot actually read another company's rows** — Postgres rejects the
query before it returns data. So the *security* boundary holds.

The remaining 283 violations are an **application correctness** problem, not
a security one:

- Updates / deletes that filter only by `organization_id` could match the
  wrong row when the same primary key exists across companies (rare, but
  nullable for tables like `payment_terms`, `email_templates`, where DB
  keys are UUIDs but application logic looks up by name).
- Lists return empty unexpectedly because RLS filters out the second
  company's rows the user *thinks* they should see, producing PGRST116 or
  silent empty states.
- Inserts may succeed but stamp the wrong `business_id` when the hook
  derives it from `currentOrg` instead of `currentBusiness`.

These are bugs that real multi-company customers WILL hit. They must be
swept before GA.

---

## Recommended path to GA

1. **Mechanical sweep (the unblocker).** ~80 files. Each file: import
   `useBusinesses`, gate query with `enabled: !!currentBusiness?.id`, add
   `.eq("business_id", currentBusiness.id)` to the chain, stamp inserts
   with `business_id`. For genuinely workspace-wide tables (per the
   `BUSINESS_SCOPED_TABLES` registry comments), add
   `// SCOPE-EXEMPT: <reason>` markers.
2. **Two-company Vitest suite.** Boots an in-memory mock with two
   Companies under one Workspace, asserts every list hook returns rows
   only for the active Company.
3. **Re-run lint + tests.** All green = certified.

Until step 3 is green, sell the product as **single-company beta only**.

---

*Last updated: 2026-04-21*
*See `ARCHITECTURE.md` for the full invariant catalogue and audit history.*

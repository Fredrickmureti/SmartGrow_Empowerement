# Payroll/Finance Hardening — Phase 2 (Posting Invariants)

**Date:** 2026-05-25
**Status:** Shipped (DB-side)

## Re-verification of prior agent's claims

| Claim | Result |
|---|---|
| `trg_default_account_settings_payroll_role` + `_payroll_assert_mapping_role` exist | **PASS** — confirmed via `pg_trigger` / `pg_get_functiondef`. |
| Trigger blocks `*_payable → 2110 accounts_payable` | **FAIL** — only checked `account_type='liability'`, not `detail_type`. Closed in this phase. |
| `payroll_generate_reclassification_je` exists, idempotent via `payroll_runs.reclassification_journal_entry_id` | **PASS** — function + column both present. |
| "Already-seeded 2140/2150/2160/2170/6150/6160 accounts" on affected tenants | **FAIL** — neither tenant had any of those codes. Provisioned in this phase. |
| Pending reclassification JE batch for run `f4b0960a-...` | **N/A** — `payroll_runs` table is currently empty (0 rows). The earlier cleanup migration is now a no-op. No JE reclassification batch required. |

## Dirty-row inventory (pre-fix)

13 rows across 2 tenants/businesses pointed payroll mappings into COGS / generic AP / parent-liability accounts:

- `81695269-0f41-4aec-8f49-2fa6d11946b2 / 7649e800` (Accrual Traders): `salary_expense → 5100 COGS`; every `*_employer_expense → 5100 COGS`; every `*_payable + net_salary_payable → 2110 AP`.
- `ad0f633a-d24c-4602-82f3-cf98ced2c246 / 7a176122`: `salary_expense → 5000 Cost of Sales`; `net_salary_payable → 2000 Liabilities (parent)`.

## Changes shipped (DB)

1. **`payroll_account_role_policy`** table — single source of truth for role → (account_type, denied detail_types). Seeded:
   - `salary_expense`, `*_employer_expense` → `{expense}`, deny `cost_of_goods_sold`.
   - `*_payable`, `net_salary_payable` → `{liability}`, deny `accounts_payable`.
2. **`_payroll_assert_mapping_role`** rewritten to consult the policy table (`account_type` + denied `detail_type`); legacy COGS heuristic kept as belt-and-braces for keys without policy rows. Header accounts still hard-denied.
3. **Per-tenant provisioning** of dedicated payroll accounts (idempotent on `(business_id, code)`):
   - Liabilities: 2140 PAYE, 2150 NSSF, 2160 SHIF, 2170 AHL, 2175 NITA, 2190 Net Salary Payable, 2199 Other Payroll Liabilities — all `detail_type IN (payroll_tax_payable, payroll_clearing)`.
   - Expenses: 6110 Staff Salaries, 6150/6160/6170/6175 employer contributions, 6199 fallback — `detail_type IN (payroll_expense, payroll_tax_expense)`.
4. **Repoint** of all 13 dirty `default_account_settings` rows via the migration (org-write-lock bypassed for the duration).
5. **`trg_enforce_payroll_je_account_class`** BEFORE INSERT/UPDATE OF account_id on `journal_entry_lines` — when parent `journal_entries.source_type='payroll'`, denies header, revenue, and `detail_type IN (cost_of_goods_sold, accounts_receivable, accounts_payable)`. Final line of defense even if mappings drift.

## Verified post-state

`SELECT … FROM default_account_settings JOIN accounts` confirms every payroll-shaped `setting_key` for both tenants now points to a dedicated payroll account with the correct `account_type` and `detail_type`. No payroll-shaped row references 5xxx (COGS) or 2110 (generic AP) anymore. The `accounts_payable` setting_key itself still points at 2110 — correct, because that's the AP module's own mapping, not payroll-shaped.

## What is NOT done in Phase 2 (deferred to later phases)

- App-side `post-payroll-gl` still uses `!` non-null assertions in places. Phase 2 sealed the DB; Phase 3/5 will rewrite the edge function to raise typed errors instead.
- `payroll_validate_post_mappings` still has its own role list; will be migrated to read `payroll_account_role_policy` in Phase 3.
- pgTAP tests (`payroll_account_class_invariant_test.sql`) and the architecture test `no-hardcoded-payroll-role-matrix` — to be added once Phase 3 work begins (kept in scope; flagged in `.lovable/plan.md`).
- Country-leakage removals (Phase 3), multi-jurisdiction schema unblock (Phase 4), pack lifecycle (Phase 5), `finance_integrity_issues` table + `/finance/integrity` page (Phase 6).

## Invariants now enforced at the DB tier

- **MAP-INV-1** Any payroll mapping write to a header / COGS detail / generic AP detail / wrong account_type is rejected by `_payroll_assert_mapping_role`.
- **JE-INV-1** Any payroll-sourced JE line landing on header / revenue / COGS / AR / generic AP is rejected by `trg_enforce_payroll_je_account_class`.

These two together make the original COGS/AP drift incident structurally impossible to reproduce, regardless of which writer (UI, RPC, edge function, future code) attempts it.

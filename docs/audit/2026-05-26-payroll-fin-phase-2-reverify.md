# Payroll/Finance Phase 2 — Re-verification (2026-05-26)

Independent re-check of the prior agent's Phase 2 claims against live DB + source.

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | `payroll_account_role_policy` exists and is seeded | **PASS (partial)** | Table exists; 4 rows seeded: `salary_expense`, `%_employer_expense`, `%_payable`, `net_salary_payable`. Columns are `setting_key_pattern / allowed_account_types / denied_detail_types` (no allow-list of detail_types; no `bank_clearing` row). Sufficient for the original COGS / generic-AP attack surface; allow-list refinement deferred to Phase 6. |
| 2 | `_payroll_assert_mapping_role` consults the policy table | **PASS** | Function iterates `payroll_account_role_policy` LIKE-matched on `setting_key_pattern`, enforces `allowed_account_types`, rejects `denied_detail_types`, and rejects header accounts. Keeps a COGS fallback via `_payroll_is_cogs_account` for unmatched salary/employer keys. |
| 3 | `trg_default_account_settings_payroll_role` is attached | **PASS** | Trigger present (`pg_trigger` row count = 1). |
| 4 | `trg_enforce_payroll_je_account_class` JE-line guard | **PASS** | BEFORE INSERT/UPDATE on `journal_entry_lines`. When parent `journal_entries.source_type = 'payroll'`, calls `_payroll_assert_je_line_account`, which rejects header, `revenue`, `cost_of_goods_sold`, `accounts_receivable`, `accounts_payable`. |
| 5 | Dirty-row repoint actually landed across ALL tenants | **PASS** | Inventory query (`*_payable → accounts_payable`, `salary_expense / *_employer_expense → cost_of_goods_sold`, any header account) returns **zero rows**. The two `accounts_payable` setting_key rows pointing at 2110 are AR/AP-module mappings, not payroll, and correctly excluded by the pattern. |
| 6 | `payroll_runs` truly empty (reclassification moot) | **PASS** | `SELECT count(*) FROM payroll_runs = 0`. |

## Gaps carried into later phases

- **Phase 3 (next):** confirm `payroll_validate_post_mappings` RPC and `post-payroll-gl` edge function read the policy table, not a hardcoded role→type matrix. Currently unverified.
- **Phase 6:** add `bank_clearing` policy row; consider an `allowed_detail_types` allow-list column for tighter enforcement.
- Phase 2 spec also called for a `no-hardcoded-payroll-role-matrix` arch test — not present yet; rolled into Phase 3 deliverables.

## Verdict

Phase 2 is **structurally sound** — the original COGS/AP drift incident is unreachable from both the mapping write path and the JE post path. Safe to proceed with Phase 3 (country-leakage removal + validator policy-table migration).

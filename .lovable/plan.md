# GL Account Mapping — Correction: Remove Branch-Scoped Account Overrides

## Why this changes
The chart of accounts is HQ-authoritative. In SAP FI/HCM, Oracle, Workday, and Dynamics 365 F&O, a branch/store/location does **not** own GL accounts — it shares one COA. Cost visibility by branch is achieved with a **posting dimension** (cost center / profit center / segment / analytic distribution) on the journal line, never with a branch-specific account. This platform already supports that: `analytic_accounts`, `analytic_groups`, `analytic_distributions`, and `branch_id` on `journal_entries` / `journal_entry_lines`.

Therefore the earlier "branch-scoped override UI + per-branch account binding" (old plan item C) is the wrong model and gets removed. The genuinely valuable part of Phase 5 — **effective-dated bindings** (temporally correct historical re-posting) — stays.

## What stays (already correct, no change)
- **Effective-dated resolver** `resolve_default_account_binding(key, org, business, branch, as_of)` and the `default_account_setting_bindings` history table, driven off the sync trigger from `default_account_settings`.
- `post-payroll-gl` resolving each `setting_key` through the resolver at the run's period-end `as_of` (historical re-posts stay correct).
- Fail-loud compute-time gate (`GL_MAPPING_CHECK_FAILED`, `mapping_issue_count`).
- Branch stamping on the JE header/lines (`branch_id`) — this is the correct branch attribution mechanism and remains.

## Work items

### C1. Make GL account mapping authoritative at org / legal-entity only
- Treat the mapping surface as governed at `organization_id` and optionally `business_id` (legal entity). Branch is **not** an override axis for accounts.
- Keep the resolver signature (it still accepts `branch_id`) but the cascade collapses branch → business → org, so a branch with no row simply resolves to the shared company/entity default. No branch rows are ever authored.
- `AccountMapping.tsx`: do **not** add any branch-override affordance or per-branch status column. The coverage table shows company (and, where applicable, legal-entity) mappings only.

### C2. Neutralize the branch axis in bindings
- Stop treating `branch_id` on `default_account_setting_bindings` as a writable override axis. No UI or RPC path creates branch-scoped binding rows.
- Decision to confirm with you (see question): either (a) leave the `branch_id` column inert for forward-compat, or (b) drop it via migration and simplify the unique index/resolver to `(org, business, setting_key)`.

### C3. Document branch cost attribution as a posting dimension
- Add code-level docs/comments in `post-payroll-gl` and `resolveDefaultAccount.ts` stating: branch differentiation is expressed via the JE line's analytic distribution / `branch_id`, never via a branch-specific account.
- Confirm payroll JE lines already carry `branch_id` (they do at lines 726/780) and, if analytic distribution is expected on payroll postings, wire the run's branch into an `analytic_distributions` entry rather than a separate account.

### D. (unchanged) Keep the fail-loud compute-time gate.

### E. Tests — adjust to the corrected model
- Update/replace `payroll_gl_binding_resolver_test.sql`: assert effective-date resolution and the branch→business→org **cascade to the shared default** (i.e. a branch with no binding resolves to the company account) — remove any assertion that authored a branch-specific account.
- Keep binding/flat-table non-divergence test.
- Add a guard test asserting no code path writes a branch-scoped account binding.

## Explicit non-goals
- No per-branch chart of accounts. No branch-specific GL account overrides.
- No schema change to `journal_entries` / `journal_entry_lines`.
- No new posting keys.

## Open question
Whether to physically drop `branch_id` from `default_account_setting_bindings` (cleaner, requires a migration) or leave it inert (no migration, forward-compatible). This is the only branching decision in the plan.

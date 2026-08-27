# Consolidation — independent re-verification (2026-08-27, handover) and Brick 4: group chart of accounts and mapping

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected; no connection work is needed.

Nothing below is taken from the previous engineer's notes on trust. Every statement was re-checked this session against the live database and the repo.

## Phase 1 — verification of the previous engineer's claims

Confirmed true:

- **Group foundation (Bricks 1–2).** `consolidation_groups` (parent business, presentation currency, translation-reserve account) and `consolidation_group_members` (ownership percent, method, effective dates, historical-rate date) exist, plus `consolidation_group_change_log` for audit. Guard and log triggers are `SECURITY DEFINER`; the reporting RPCs are not.
- **Scope security.** `resolve_consolidation_scope` is invoker-rights and returns a blocker rather than a partial answer; only the member-count helper is definer.
- **One accounting engine.** `get_consolidated_trial_balance_translated` resolves scope, then returns each member's figures from `consolidation_translate_member`. The React hooks and pages contain no accounting arithmetic.
- **FX translation (Brick 3).** `consolidation_translate_member`, `consolidation_member_translation_rates` and `consolidation_cta_reconciliation` exist and classify each line closing / average / historical / transaction.
- **Consolidated statements (Brick 5).** `get_consolidated_statement_lines` / `get_consolidated_statement_totals` exist, carry the unposted period result as its own equity line, and return a balance check.
- **Execute grants.** None of the consolidation reporting functions is executable by `anon`; they are granted to `authenticated` and `service_role` only. The earlier `PUBLIC` leak is genuinely closed. One residual: the trigger helper `_consolidation_cta_account_guard` still carries an `anon` execute grant — harmless in practice but inconsistent, and worth revoking with this brick.
- **UI surfaces.** `ConsolidationGroupsSettings.tsx`, `ConsolidatedTrialBalance.tsx`, `ConsolidatedStatements.tsx` and the three finance hooks are wired to the RPCs; two report routes are registered.

Confirmed gaps — these are the real outstanding work:

1. **No account mapping, and it is a live correctness defect.** There are no group-chart or mapping tables in the database. `get_consolidated_statement_lines` groups `BY t.account_id, t.account_type`, and accounts are business-scoped: the two tenant companies hold 155 and 24 accounts with no shared identity. Two companies' "4000 Sales" therefore produce two unrelated group lines. Consolidated statements are only correct for a single-company group today.
2. **The translation path has never produced a real number in this tenant.** Both businesses are KES-based and one has zero journal lines (37 lines total, all in the other). The five SQL suites in `supabase/tests/` build and roll back their own data, so they exercise the logic — but no live multi-currency group exists.
3. **No intercompany, no eliminations, no persisted consolidation runs, no consolidated cash flow.** Absent from the database, and honestly declared absent in the UI copy. Correct for now.

## Phase 2 — additions to the plan

- Account mapping comes before any further reporting work; eliminations built on a report that cannot merge two charts of accounts would bury the defect underneath new work.
- Mapping must be explicit and auditable rows, never inference from account codes at read time. Codes collide and drift, and a group line whose composition changes silently when someone renames an account is not auditable.
- An unmapped posted account must never be silently dropped or silently passed through as its own group line. Both manufacture a figure nobody chose. The report refuses and names the accounts, matching the existing rate-coverage and reserve-account blockers.
- Revoke the stray `anon` execute grant on `_consolidation_cta_account_guard` as part of this brick's migration.

## Brick 4 — scope

**Database**

- `consolidation_group_accounts`: group-owned chart (code, name, `account_type`, ordering, active flag), unique code per group.
- `consolidation_account_mappings`: one row per member account → group account, with effective dating, creator and timestamps.
- Constraints: member account and group account must share the same `account_type`; the member business must be in the group; no overlapping effective periods for the same member account; the translation-reserve account keeps its dedicated treatment and is not mappable as an ordinary line.
- Change logging for both tables through the existing consolidation change-log pattern.
- RLS mirroring `consolidation_groups` (organization-scoped, caller must reach the group), explicit grants to `authenticated` and `service_role`, no `anon`.
- Reporting functions resolve member accounts to group accounts and aggregate on the group account, keeping the member account for drill-down. Coverage is a refusal condition: posted balances in unmapped accounts block the report and are named.
- A group whose members share one chart must return byte-identical numbers — mapping is the identity function there.

**Application**

- Group chart-of-accounts and mapping management inside the consolidation group settings area: per-member unmapped-accounts worklist, and a "map by matching code" assist that writes explicit rows rather than inferring at read time.
- Trial balance and statements group by group account with per-member drill-down to the originating account.
- The refusal is rendered as an explanation listing the offending accounts with a link to map them.

**Validation**

- Run all five existing SQL suites first and record results; fix anything they surface before adding code.
- New suite: two different charts mapped to a common group chart merge into one line per group account; an unmapped posted account refuses the report; a single-chart group is unchanged; a cross-account-type mapping is rejected; RLS isolates mappings across organizations.
- Extend the architecture test so a consolidation RPC with no application consumer fails the build.

**Checkpoint.** When Brick 4 closes, this file records what was established, the accounting rules that now hold, the security boundaries, the tests that passed, and what Brick 6 depends on.

## Explicitly out of scope until Brick 4 closes

Intercompany identification, eliminations, consolidated cash flow, persisted consolidation runs, equity method. No placeholders, no TODO scaffolding, no disabled buttons for any of them.

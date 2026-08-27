# Consolidation — independent verification (2026-08-27) and Brick 4: group account mapping

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected. No connection work is needed.

Nothing below is carried over from the previous engineer's notes on trust. Every statement was checked in this session against the live database and the files in the repo.

## Phase 1 — what is actually there

### Verified as genuinely built

- **One accounting engine.** All consolidation database functions read the authoritative ledger primitives; the comparative page and the hooks contain no accounting arithmetic. `get_consolidated_trial_balance_translated` loops the resolved scope and returns each member's already-translated figures.
- **Group foundation and scope security.** `consolidation_groups` and `consolidation_group_members` exist with parent, ownership percent, method, effective dates, presentation currency and a translation-reserve account. Both have RLS with policies. `resolve_consolidation_scope` refuses the whole report when the caller cannot reach every company in scope; only the member-count helper is SECURITY DEFINER.
- **FX translation and the translation reserve.** `consolidation_translate_member`, `consolidation_member_translation_rates` and `consolidation_cta_reconciliation` all exist, class each line as closing / average / historical / transaction, and prove the reserve movement independently rather than restating the residual.
- **The configuration and reporting surfaces are wired** (contrary to the last plan file, which is stale): the group settings screen has a translation-reserve account selector restricted to the parent's equity accounts and a per-member historical-rate date; the consolidated trial balance consumes the translated RPC with rate class, rate applied, per-member contributions, the reconciliation panel and a non-controlling-interest disclosure.
- **Consolidated statements exist.** `get_consolidated_statement_lines` / `get_consolidated_statement_totals` build the income statement and balance sheet off the translated trial balance, carry the unposted result for the period as its own equity line, and return a balance check.

### Verified gaps

1. **No account mapping — and this is a live correctness defect.** Accounts are per company: one company here has 155 accounts, the other 24, with no shared identity. Both the trial balance and the statements group by `account_id`, so two companies' "4000 Sales" appear as two unrelated group lines. Consolidated statements today are only correct for a single-company group.
2. **Nothing has ever been executed.** Four SQL invariant suites exist in `supabase/tests/`; none has been run in any recorded session. No multi-currency group and no foreign-currency posting exists in the tenant, so the translation path has never produced a real number.
3. **No intercompany, no eliminations, no persisted runs, no consolidated cash flow.** Confirmed absent from the database — and honestly declared as absent in the UI copy, which is the correct behaviour for now.

## Phase 2 — additions to the plan

- Account mapping must come *before* any further reporting work. Building eliminations on top of a report that cannot merge two charts of accounts would put the defect underneath the new work.
- Mapping must be explicit and auditable, not inferred from account codes at read time. Codes collide and drift; a group statement whose line composition silently changes when someone renames an account is not auditable.
- An unmapped account must never be silently dropped or silently passed through as its own line. Either behaviour manufactures a group figure nobody chose.

## Brick 4 — group chart of accounts and mapping

Scope, complete before anything else starts:

**Database**
- A group-level chart of accounts (code, name, account type, ordering) owned by the consolidation group, and a mapping row per member account to a group account, with effective dating and an audit trail of changes.
- Constraints that keep a mapping honest: a member account can only map to a group account of the same account type; a mapping can only reference companies inside the group; the reserve account keeps its existing dedicated treatment.
- RLS mirroring the existing consolidation tables, plus explicit grants; no `anon` access.
- `consolidation_translate_member` and the trial-balance / statement functions resolve member accounts to group accounts. Coverage is a refusal condition: if a member has posted balances in accounts with no mapping, the report refuses and names them, exactly as the existing rate-coverage and reserve-account blockers do.
- Groups whose members share one chart of accounts must keep producing byte-identical numbers — the mapping layer is an identity function there.

**Application**
- Group chart of accounts and mapping management in the consolidation group settings area, with an unmapped-accounts worklist per member and a one-click "map by matching code" assist that writes explicit rows rather than inferring at read time.
- Trial balance and statements group by group account, keeping per-member drill-down to the originating account.
- The refusal is surfaced as an explanation with the offending accounts listed and a link to fix them.

**Validation**
- Run the four existing suites first and record the results; fix whatever they surface before adding code.
- New suite: two companies with different charts of accounts mapped to a common group chart produce one merged line per group account; an unmapped posted account refuses the report; a single-chart group is unchanged; mapping to a different account type is rejected.
- Architecture test extended so a consolidation RPC without an application consumer fails the build.

**Checkpoint.** When Brick 4 closes, this file records what was established, the accounting rules that now hold, the security boundaries, the tests that passed, and what Brick 5 depends on.

## Explicitly out of scope until Brick 4 closes

Intercompany identification, eliminations, consolidated cash flow, persisted consolidation runs, equity method. No placeholders, no TODO scaffolding, no disabled buttons for any of them.

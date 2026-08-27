# Consolidation — independent verification (2026-08-27, evening) and Brick 6: intercompany foundation

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected. No connection work is needed.

Nothing here is taken from the previous engineer's notes on trust. Every statement below was re-checked this session against the live database and the repo.

## Phase 1 — verified current state

| Previous claim | Verdict | Evidence |
| --- | --- | --- |
| Group foundation + scope security (Bricks 1–2) | True | `consolidation_groups`, `consolidation_group_members`, `consolidation_group_change_log` exist; `resolve_consolidation_scope` is INVOKER-rights, only `consolidation_scope_member_count` and the trigger guards are `SECURITY DEFINER` |
| One accounting engine | True | The consolidation functions read the authoritative ledger primitives; the pages and hooks hold no accounting arithmetic |
| FX translation + CTA (Brick 3) | True | `consolidation_translate_member`, `consolidation_member_translation_rates`, `consolidation_cta_reconciliation`, `get_consolidated_trial_balance_translated` all present |
| Consolidated statements (Brick 5) | True | `get_consolidated_statement_lines` / `_totals` are projections of the translated trial balance; unposted period result is its own equity line; report refuses rather than showing an unbalanced statement |
| Brick 4 account mapping landed | Substantially true | `consolidation_group_accounts`, `consolidation_account_mappings` (+ `_consolidation_mapping_guard`/`_log`), `consolidation_unmapped_accounts`, `consolidation_group_uses_group_chart` exist; `get_consolidated_statement_lines` groups by `group_account_id`, the translated trial balance refuses on unmapped posted accounts; `useConsolidationAccountMapping` and `ConsolidationAccountMapping` (582 lines) are wired into group settings, and the trial balance surfaces the unmapped count |
| Stray `anon` execute grant on `_consolidation_cta_account_guard` | Already fixed | ACL is `postgres`/`service_role` only |
| Intercompany / eliminations / consolidation runs exist | False, and correctly absent | No table matching intercompany, elimination, related-party, trading-partner or consolidation-run exists |

Real outstanding gaps found this session:

1. **Brick 4 has no database-level validation.** `supabase/tests/` contains suites for the group foundation, translation, trial balance and statements — but none for mapping. The mapping semantics that matter (two charts merging onto one group account, refusal on an unmapped posted account, cross-account-type rejection, single-chart identity, cross-organization RLS isolation) are unproven.
2. **No architecture ratchet on the mapping surface.** The existing ratchet asserts consolidation RPCs are reachable from a hook; nothing prevents the mapping tables from drifting out of the UI.
3. **Intercompany is greenfield, and the hook already exists in the ledger.** `journal_entry_lines` carries `contact_id`, and `contacts` carries `business_id`, `commercial_partner_id`, `parent_contact_id`. Intercompany identification should build on that counterparty link — not on account names or descriptions.

## Phase 2 — plan additions

- Close Brick 4 with real database proof before starting Brick 6. An implemented capability with no executable invariant is not a closed brick.
- Brick 6 delivers *identification only*: which ledger activity is intercompany, and against which group member. No elimination arithmetic, no consolidation-run persistence, no minority interest. Those are Bricks 7–8.
- Intercompany identity must be an explicit, auditable link from a contact to a group member business — never inferred from names, codes or descriptions at read time.
- The intercompany report must be a projection of the same translated engine, so an intercompany figure and a consolidated figure can never disagree.
- Unreciprocated intercompany balances (A says receivable 100, B says payable 90) must be surfaced as a named difference, never quietly netted.

## Work order

### Step A — close Brick 4 (blocking)

- New suite `supabase/tests/consolidation_account_mapping_test.sql`: two members with different charts mapped onto one group chart merge to one line per group account; a posted balance in an unmapped account refuses the report and names the account; a single-chart group returns byte-identical figures to the unmapped path; a mapping across account types is rejected by the guard; a mapping belonging to another organization is invisible under RLS; effective-dated overlap on the same member account is rejected.
- Record the execution result of every consolidation suite in this file. A suite that has not been run is not evidence.
- Extend the architecture ratchet so the group-chart and mapping tables must appear in a hook, and so the trial balance page must render the unmapped refusal.
- Fix anything the suites surface before writing new features.

### Step B — Brick 6, database

- `consolidation_intercompany_partners`: for a group, an explicit effective-dated link from a `contacts` row in one member business to the counterparty member business, with creator, timestamps and change logging via the existing consolidation log pattern. Unique per group / contact / period. Guard: both businesses must be members of the group over the link's effective period; the contact must belong to the declaring member business; a business cannot be its own counterparty.
- `consolidation_intercompany_balances(_group_id, _date_from, _date_to)`: reads the translated engine, joins ledger lines to declared partners, and returns per member pair, per group account, the declaring side, the counterparty side, presentation-currency amounts, and the unreciprocated difference.
- `consolidation_intercompany_coverage(...)`: names ledger activity against a contact that resolves to a member business but has no declared partner link — the worklist that keeps Brick 7 honest.
- RLS mirroring `consolidation_groups` (organization-scoped, caller must reach the group and both businesses), grants to `authenticated` and `service_role` only, no `anon`. INVOKER rights everywhere except triggers.

### Step C — Brick 6, application

- Intercompany partner management in the consolidation group settings area: declare counterparties per member, effective dates, and a coverage worklist for undeclared counterparty activity.
- An intercompany report under finance reporting: pairs, group accounts, both sides, differences, drill-down to the originating member account and journal lines.
- Refusals rendered as explanations naming the offending rows, matching the existing scope, rate-coverage and mapping refusals.

### Step D — Brick 6, validation

- New suite: partner guard rejects non-member counterparties, self-counterparty and foreign-business contacts; balances function pairs both sides correctly; asymmetric balances report a difference rather than netting; RLS isolates partners across organizations; a group with no declared partners returns an empty result and never a fabricated one.
- Architecture ratchet extended to the new RPCs.

### Checkpoint

When Brick 6 closes, this file records what was established, the accounting rules that hold, the security boundaries, the suites that were executed with their results, and what Brick 7 depends on.

## Explicitly out of scope until Brick 6 closes

Elimination arithmetic, persisted consolidation runs, consolidated cash flow, equity method, minority interest. No placeholders, no TODO scaffolding, no disabled buttons for any of them.

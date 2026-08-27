# Consolidation — independent verification (2026-08-27, 08:0x UTC) and closing Brick 6

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected; no connection work is needed.

Everything below was re-checked this session against the live database and the repository. No claim from the previous engineer's status note was accepted without a direct check.

## Phase 1 — what is genuinely in place

Verified by direct queries against the connected database:

- **Group foundation, translation, mapping (Bricks 1–5)** exist as described: `consolidation_groups`, `consolidation_group_members`, `consolidation_group_accounts`, `consolidation_account_mappings`, `consolidation_group_change_log`, with guard and audit triggers attached to each, and the engine functions `resolve_consolidation_scope`, `get_consolidated_trial_balance`, `get_consolidated_trial_balance_translated`, `consolidation_translate_member`, `consolidation_member_translation_rates`, `consolidation_cta_reconciliation`, `consolidation_unmapped_accounts`, `get_consolidated_statement_lines` / `_totals`. All report functions are INVOKER-rights; only trigger guards and `consolidation_scope_member_count` are DEFINER.
- **The duplicate CTA guard trigger is genuinely fixed.** `consolidation_groups` now carries exactly one attachment of `_consolidation_cta_account_guard`.
- **Brick 6 schema landed.** `consolidation_intercompany_partners` exists with guard (`_consolidation_partner_guard`) and audit (`_consolidation_partner_log`) triggers, RLS on, no `anon` privileges.
- **Brick 6 engine and UI landed.** `consolidation_intercompany_balances` exists, is INVOKER-rights, gates on `resolve_consolidation_scope`, and refuses rather than approximating when a closing rate is missing. `src/pages/reports/ConsolidationIntercompany.tsx` (466 lines), `src/hooks/finance/useConsolidationIntercompany.ts`, the route at `reports/intercompany`, sidebar/registry/report-registry entries, and a 10-test architecture ratchet all exist. The ratchet and the account-mapping ratchet were executed this session: 19 tests, all passing.
- `supabase/tests/consolidation_intercompany_test.sql` (243 lines) exists and is a real suite — contract block plus behaviour block, both rolling back.

## Phase 1 — where the previous engineer's account does not hold

Three findings. Brick 6 is **not** closeable as it stands.

1. **The Brick 6 SQL suite has never been executed.** `.lovable/consolidation-brick-log.md` still ends at "Brick 4 CLOSED / Next — Brick 6" and contains no Brick 6 section. The suite's assertions are therefore unproven: reciprocal pairing, the 2 000 asymmetry, the four guard rejections and the audit-log assertion are all written but unverified.
2. **The declared coverage worklist (`consolidation_intercompany_coverage`) does not exist.** The plan made it a Step C deliverable and Step D put it on the page; neither the function nor any reference to it exists in the database or the repository. Without it there is no way to name ledger activity against a contact that resolves to a member business but carries no declaration — which is exactly the honesty gate Brick 7 depends on.
3. **The engine's data source deviates from the stated architecture, and the deviation is not documented.** `consolidation_intercompany_balances` reads `customer_ledger_entries` and `vendor_ledger_entries`, not `get_consolidated_trial_balance_translated` as the plan's technical note asserts. That is a defensible choice — the sub-ledgers carry the counterparty identity the GL does not — but as written it means: intercompany positions arising outside AR/AP (intercompany loans, management fees, recharges booked straight to GL) are invisible; there is no group-account dimension on the result, so the figures cannot be tied to a consolidated statement line; and `_date_from` only influences rate selection while balances accumulate on `entry_date <= _date_to`.

Also true, and material: **consolidation has still never run against more than one member.** The live database holds one group, one member, zero group accounts, zero mappings and zero declarations. Every multi-entity proof exists only inside rolling-back test transactions.

## Phase 2 — plan corrections

- Brick 6 stays **identification only**. No elimination arithmetic, no persisted runs, no minority interest.
- The AR/AP sub-ledger basis is kept and made explicit, and the engine is extended so that a declared pair's GL-side intercompany activity is reported alongside it with its group account — so an intercompany figure can be tied back to the consolidated statement line it belongs to. Positions that no declaration explains are listed, never inferred.
- The coverage worklist becomes a blocking deliverable for closing Brick 6, not a nice-to-have.
- A brick is closed only when its suite has been executed against the live database and the result recorded in the brick log.

## Work order

### Step 1 — extend the engine to the ledger, keeping one source of truth (one migration)

Add a group-account dimension and GL-side intercompany activity to `consolidation_intercompany_balances`: for each declared pair, join `journal_entry_lines.contact_id` to the declaration, resolve the account through the same mapping the statements use (`get_consolidated_trial_balance_translated` / `consolidation_account_mappings`), and translate through the existing rate resolver. No second rate book, no second ledger, no JavaScript arithmetic. Keep the existing refusal behaviour: unresolved scope, missing closing rate, or unmapped accounts refuse the report and name the offending rows.

### Step 2 — coverage worklist (one migration)

`consolidation_intercompany_coverage(_group_id, _date_from, _date_to)`: ledger and sub-ledger activity against a contact that resolves to a member business of the group but has no declaration covering the period. INVOKER-rights, `anon` execute revoked, same scope gate, returns empty rather than fabricating when the group has no members with activity.

### Step 3 — surface coverage on the existing page

Add the worklist to `ConsolidationIntercompany.tsx` beside the declare/reconcile sections, with a direct path from a listed row into declaring that relationship. Group-account columns appear on the reconciliation table with drill-down to the originating member account and journal lines. Refusals render as explanations naming the offending rows, matching the existing scope, rate and mapping refusals.

### Step 4 — validation, executed and recorded

- Extend `supabase/tests/consolidation_intercompany_test.sql` with: GL-side intercompany activity paired and tied to its group account; a pair with activity in an unmapped account refused, not silently dropped; coverage naming an undeclared counterparty and falling silent once declared; RLS isolating declarations across organizations.
- **Execute** the whole suite against the live database and record the result.
- Extend the architecture ratchet for the coverage RPC and the new page section.
- Drive a genuine two-member group (different currencies, different account codes) through group settings, trial balance, statements and the intercompany page in the running app, and record what was observed.
- Write the Brick 6 section of `.lovable/consolidation-brick-log.md`: what was established, changed, verified, which accounting rules and security boundaries now exist, which suites ran, and what is deliberately still absent.

## Explicitly out of scope until Brick 6 closes

Elimination arithmetic, persisted consolidation runs, consolidated cash flow, equity method, minority interest. No placeholders, no TODO scaffolding, no disabled controls for any of them.

## Technical notes

- Migrations stay small and single-purpose (one object each), per the standing rule for this database.
- Grants on any new object: `authenticated` and `service_role` only.
- Contact-to-business scoping uses `contacts.business_id` and `contacts.organization_id`; `commercial_partner_id` / `parent_contact_id` stay contact-hierarchy concerns.
- Unreciprocated balances are reported as a named difference and never netted.

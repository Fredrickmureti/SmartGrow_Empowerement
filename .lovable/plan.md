# Consolidation — verification (2026-08-27, 07:0x UTC) and Brick 6: intercompany identification

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected — no connection work needed.

Everything below was re-checked this session against the live database and the repo. Nothing is carried over from the previous engineer's claims.

## Phase 1 — what is actually there

Confirmed present in the database (queried directly):

- **Group foundation**: `consolidation_groups` (parent business, presentation currency, CTA account), `consolidation_group_members` (parent business, `ownership_percent`, `method`, `effective_from/to`, `historical_rate_date`), `consolidation_group_change_log`. RLS on, policies scoped by `is_org_member` + `user_can_access_business` for reads and org owner/admin roles for writes. No `anon` privileges on any consolidation table.
- **Account mapping (Brick 4)**: `consolidation_group_accounts`, `consolidation_account_mappings`, both with guard and audit triggers attached. The shared audit trigger now reads the row generically out of `to_jsonb`, so the previously fatal `NEW.business_id` bug is genuinely fixed.
- **Engines**: `resolve_consolidation_scope`, `get_consolidated_trial_balance`, `get_consolidated_trial_balance_translated`, `consolidation_translate_member`, `consolidation_member_translation_rates`, `consolidation_cta_reconciliation`, `consolidation_unmapped_accounts`, `consolidation_group_uses_group_chart`, `get_consolidated_statement_lines`/`_totals`. All are INVOKER-rights; only the trigger guards and `consolidation_scope_member_count` are DEFINER; `anon` can execute none of them.
- **App surface**: `Consolidation.tsx`, `ConsolidatedTrialBalance.tsx`, `ConsolidatedStatements.tsx` plus four `useConsolidat*` hooks; six SQL suites and four architecture ratchets. The four architecture suites were executed this session: 40 tests, all passing.

Confirmed genuinely absent: any intercompany, elimination, related-party, trading-partner or persisted consolidation-run table or column. Nothing to preserve or integrate — Brick 6 is greenfield.

Two real defects found this session that the previous notes do not mention:

1. **Duplicate CTA guard trigger.** `consolidation_groups` carries both `consolidation_cta_account_guard` and `trg_consolidation_cta_account_guard`, bound to the same function. The guard runs twice on every group write; a rejection surfaces twice and a future guard change has two attachment points to keep in step. One must be dropped.
2. **Consolidation has never been exercised with more than one member.** The live group has exactly one member business, and the group chart and mapping tables hold zero rows. Every multi-entity proof lives only inside rolling-back test transactions. This is not a code defect, but it means the group/mapping UI has never been driven against real data — the trial balance and statement pages must be walked through against a genuine two-member group as part of this brick's validation.

## Phase 2 — plan additions

- Fix the duplicate trigger before adding new schema; it is a one-object migration.
- Brick 6 is **identification only**: which ledger activity is intercompany and against which member business. No elimination arithmetic, no persisted runs, no minority interest — those are Bricks 7 and 8.
- Intercompany identity must be an explicit, effective-dated, auditable link from a `contacts` row to a counterparty member business. Never inferred from account names, codes or descriptions. `journal_entry_lines.contact_id` already exists (populated on 7 of 37 current lines) and is the join key.
- The intercompany report must be a projection of the same translated engine, so an intercompany figure and a consolidated figure can never disagree.
- Unreciprocated balances (A says receivable 100, B says payable 90) are reported as a named difference, never quietly netted.
- A coverage worklist must name ledger activity against a contact that resolves to a member business but has no declared link — that worklist is what keeps Brick 7 honest.

## Work order

### Step A — hygiene (blocking, one small migration)

Drop the redundant CTA guard trigger, keeping a single attachment. Confirm afterwards that exactly one trigger references `_consolidation_cta_account_guard`.

### Step B — Brick 6 schema (one migration)

`consolidation_intercompany_partners`: organization, group, declaring business, `contact_id`, counterparty business, effective from/to, notes, creator, timestamps. Grants to `authenticated` and `service_role` only; RLS mirroring `consolidation_account_mappings` (org member + access to both businesses + access to the group's parent business; writes restricted to org owner/admin/super_admin). Guard trigger rejects: a counterparty that is not a group member over the link's period, a declaring business that is not a member, a contact that does not belong to the declaring business, self-counterparty, and an overlapping period for the same contact. Audit trigger reuses the existing consolidation change-log pattern.

### Step C — Brick 6 engines (separate migrations, one function each)

- `consolidation_intercompany_balances(_group_id, _date_from, _date_to)` — reads the translated engine, joins ledger lines to declared partners, returns per member pair and group account: declaring side, counterparty side, presentation-currency amounts, and the unreciprocated difference.
- `consolidation_intercompany_coverage(_group_id, _date_from, _date_to)` — undeclared counterparty activity worklist.

Both INVOKER-rights, `anon` execute revoked, refusing rather than fabricating when scope, rates or mappings are incomplete.

### Step D — application

- Intercompany partner management inside consolidation group settings: declare counterparties per member with effective dates, plus the coverage worklist.
- An intercompany report under finance reporting built on `src/design-system/reports` (no hand-rolled tables, no JS arithmetic), with drill-down to the originating member account and journal lines.
- Refusals rendered as explanations naming the offending rows, matching the existing scope, rate-coverage and mapping refusals.

### Step E — validation

- `supabase/tests/consolidation_intercompany_test.sql`: guard rejects non-member counterparty, self-counterparty, foreign-business contact and overlapping periods; both sides of a real intercompany sale pair correctly; an asymmetric pair reports a difference rather than netting; a group with no declared partners returns empty, never fabricated; RLS isolates partners across organizations.
- Architecture ratchet for the new RPCs and the mapping/partner UI reachability.
- Walk a genuine two-member group through the group settings, trial balance, statements and new intercompany pages, and record what was observed.
- Every executed suite and its result recorded in `.lovable/consolidation-brick-log.md`.

## Explicitly out of scope until Brick 6 closes

Elimination arithmetic, persisted consolidation runs, consolidated cash flow, equity method, minority interest. No placeholders, no TODO scaffolding, no disabled buttons for any of them.

## Technical notes

- Migrations stay small and single-purpose (one object each) per the standing rule for this database.
- No second FX resolver and no second accounting engine: intercompany figures come from `get_consolidated_trial_balance_translated` and the existing rate book.
- Contact→business scoping uses `contacts.business_id` (NOT NULL) and `contacts.organization_id`; `commercial_partner_id`/`parent_contact_id` remain contact-hierarchy concerns and are not repurposed as intercompany links.

# Consolidation — handover verification (2026-08-27, 08:4x UTC) and closing Brick 6

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected; no connection work is needed.

Every claim below was re-checked this session against the live database and the repository. Nothing in the previous engineer's status note was accepted on trust.

## Phase 1 — what the previous engineer actually landed

Confirmed present:

- Bricks 1–5 objects all exist in the live database: `consolidation_groups`, `consolidation_group_members`, `consolidation_group_accounts`, `consolidation_account_mappings`, `consolidation_group_change_log`, `consolidation_intercompany_partners`, each with its guard and audit trigger function, plus the engine functions `resolve_consolidation_scope`, `consolidation_translate_member`, `consolidation_member_translation_rates`, `get_consolidated_trial_balance`, `get_consolidated_trial_balance_translated`, `get_consolidated_statement_lines` / `_totals`, `consolidation_cta_reconciliation`, `consolidation_unmapped_accounts`.
- **Step 1 landed.** `consolidation_intercompany_activity(_group_id, _date_from, _date_to)` exists, is INVOKER-rights, granted only to `authenticated` and `service_role`, and projects intercompany journal activity onto the translated consolidated trial balance — so the group-account dimension and the rate used come from the same engine the statements use, not from a second calculation. It refuses (SQLSTATE 22023) and names the offending account/company when intercompany activity touches an account the consolidated trial balance does not report.
- **Step 2 landed.** `consolidation_intercompany_coverage(_group_id, _date_from, _date_to)` exists with the same rights and grant profile.
- **Step 3 landed.** `useConsolidationIntercompany.ts` exposes both RPCs, and `ConsolidationIntercompany.tsx` renders the coverage worklist with its own error, loading and empty states alongside the existing declare/reconcile sections.

## Phase 1 — what is not true, and what therefore remains open

- **Step 4 has not been started.** `supabase/tests/consolidation_intercompany_test.sql` is still the original 243-line suite: it contains no assertion mentioning the activity projection, the coverage worklist, the group-account dimension, or the unmapped-account refusal.
- **No suite has been executed for Brick 6.** `.lovable/consolidation-brick-log.md` still ends at "Brick 4 — CLOSED" followed by "Next — Brick 6". There is no recorded execution and no Brick 6 section.
- **The architecture ratchet was not extended.** `src/test/architecture/consolidation-intercompany.test.ts` exists but contains no reference to the coverage RPC, the activity RPC, or the group-account columns, so the new surface is unguarded against regression.
- **Consolidation has still never run against more than one member.** The live group set holds a single member, zero group accounts, zero mappings, zero declarations. Every multi-entity proof exists only inside rolling-back test transactions.

So Brick 6 is code-complete but unproven. Brick 6 is not closeable, and Brick 7 (eliminations) must not start.

## Phase 2 — plan corrections carried forward

- Brick 6 stays identification only: no elimination arithmetic, no persisted runs, no minority interest, no placeholders.
- One accounting truth: intercompany figures stay a projection of `get_consolidated_trial_balance_translated`. No second rate resolver, no JavaScript arithmetic.
- A brick closes only when its SQL suite has been executed against the live database and the result recorded in the brick log.
- Added to the worklist from this session's review: the refusal path in `consolidation_intercompany_activity` must be asserted (an unmapped intercompany account must refuse, never silently drop), and cross-organization RLS isolation of declarations must be asserted, because neither is covered today.

## Work order — Brick 6 closure

### Step 4a — extend the SQL suite

Add to `supabase/tests/consolidation_intercompany_test.sql`, keeping the contract-block / behaviour-block shape and the rollback:

- A two-member group in different currencies with different account codes: GL-side intercompany activity (a recharge booked straight to GL, not through AR/AP) is reported, carries the group account, and its translated amount matches the rate the translated trial balance used.
- An intercompany account left unmapped: the activity report refuses and the message names the account and company.
- Coverage names a counterparty with ledger activity and no declaration, and falls silent once the declaration covers the period.
- Coverage suggests a counterparty only on exact tax/registration-number identity, never on a name match.
- A foreign organization reads neither declarations nor coverage; the owning user is not over-blocked.
- Reciprocal pairing and the unreciprocated difference stay reported as a named difference, never netted.

### Step 4b — execute the suite and record the result

Run the whole Brick 6 suite against the live database, plus the Brick 1–5 suites as a regression pass, and record pass/fail per block.

### Step 4c — extend the architecture ratchet

Extend `src/test/architecture/consolidation-intercompany.test.ts` so it holds: the coverage RPC stays reachable from the page, the client never derives intercompany pairs or account mappings itself, group-account columns stay on the reconciliation table, and refusals stay rendered as explanations rather than empty tables.

### Step 4d — live multi-member walkthrough

Drive a genuine two-member group (different base currencies, different charts) through group settings, consolidated trial balance, consolidated statements and the intercompany page in the running app; record what was observed, including one deliberate refusal.

### Step 4e — write the Brick 6 section of the brick log

What was established, changed and verified; the accounting rules and security boundaries that now exist; which suites ran; what is deliberately still absent.

## Explicitly out of scope until Brick 6 closes

Elimination arithmetic, persisted consolidation runs, consolidated cash flow, equity method, minority interest. No TODO scaffolding and no disabled controls for any of them.

## Technical notes

- Any new database object goes in its own small migration; grants to `authenticated` and `service_role` only.
- Test data is created and rolled back inside the suite; nothing is seeded into the live tenant.
- Contact-to-business scoping uses `contacts.business_id` / `contacts.organization_id`; `commercial_partner_id` and `parent_contact_id` stay contact-hierarchy concerns.

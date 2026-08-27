# Consolidation — verified handover (2026-08-27, 11:2x UTC) and Brick 7

## What I verified myself this session (not taken from the previous notes)

Checked directly against the connected database (`AccrualFlowCorporation`) and the repo:

- Six consolidation tables exist: groups, group members, group accounts, account
  mappings, intercompany partners, group change log. Live data present: 1 group,
  2 members, 7 group accounts, 147 mappings, 2 intercompany declarations, 162
  change-log rows. So the seed the previous engineer described is real.
- The engine functions exist and are substantial: scope resolution, member
  translation rates, member translation, translated trial balance, statement
  lines and totals, CTA reconciliation, intercompany balances / activity /
  coverage, unmapped-account worklist, plus eleven guard and log triggers.
- **No duplicate accounting engine.** `consolidation_translate_member` builds on
  the authoritative primitives (`get_ledger_opening_balances`,
  `get_account_movements`, `get_gl_transactions`, `fx_rate_on`) rather than
  re-deriving balances. Equity is translated at transaction-date rates and
  missing rates are refused, not approximated — this matches IAS 21 rather than
  merely looking finished.
- Frontend is wired, not orphaned: consolidated trial balance, consolidated
  statements and intercompany identification pages all exist, are routed under
  Finance reports, and are registered in the report registry and reports nav.
  The old cross-company page survives as an explicitly native-currency
  comparative, and states in code that it does not sum or translate.
- The 5 consolidation architecture test files run green: **66 tests passing**.
- Seven SQL suites are committed for bricks 1–6.

## Gaps I found in the handover — real pending work

1. **Unverified test claims.** Only the TypeScript ratchet was re-run. The SQL
   suites for bricks 1–5 (group foundation, translation, trial balance,
   reconciliation, statements, account mapping) were not executed in the last
   session, so their pass status is a claim.
2. **The handover contradicts itself** on the intercompany suite: the brick log
   says all three blocks passed, the status note lists blocks 1 and 2 as still
   to run. Must be settled by execution.
3. **Brick log is incomplete** — no sections for bricks 1, 2, 3, 5, so there is
   no verified record of what those bricks actually guarantee.
4. **No elimination or consolidation-run objects exist** in the database. Brick 7
   and 8 are genuinely unstarted (this part of the handover is accurate).
5. **No browser walkthrough** was possible (external Supabase, no injectable
   session). The pages are only covered by static tests.

## Additional work I am adding, from an ERP/accountant reading of the domain

Not in the previous plan and justified before or alongside eliminations:

- **Ownership and non-controlling interest.** Members carry an ownership basis
  (`full` / `proportional`), but there is no NCI treatment. IFRS 10 requires
  full consolidation with NCI presented in equity; proportional basis is not a
  substitute. Needs its own brick after eliminations, and the elimination model
  must not assume 100 percent ownership.
- **Period-close interaction.** Eliminations and runs must respect fiscal-period
  locks; a run over a closed period must be reproducible but not re-postable.
- **Re-run idempotency.** A run must be versionable and supersede rather than
  duplicate; this is a schema requirement, not a UI concern.
- **Drill-down contract.** Every consolidated figure must resolve back to member,
  member account, group account, rate class and rate used — already true for the
  trial balance, must be preserved through eliminations.

## Order of work

```text
Phase 0  Verify bricks 1-6 by execution, backfill the brick log
Brick 7  Elimination engine (intercompany elimination entries)
Brick 8  Consolidation runs, versioning, audit trail
Brick 9  Ownership / NCI presentation
Brick 10 Consolidated cash flow (only if the primitives support it)
```

## Phase 0 — verification and record (do first, no new features)

1. Execute each committed SQL suite against the live database, one at a time,
   recording pass/fail per block: group foundation, translation, trial balance,
   trial balance reconciliation, statements, account mapping, intercompany
   (all three blocks). Every suite is self-rolling-back; residue is checked
   after each run.
2. Fix whatever fails — in the engine when the engine is wrong, in the fixture
   when the fixture is wrong, and say which in the log.
3. Run the Supabase linter and resolve any consolidation-related finding
   (privileges, RLS, function search paths).
4. Backfill brick-log sections for bricks 1, 2, 3 and 5 from executed evidence
   only, and resolve the intercompany contradiction.

Exit condition: every consolidation suite has an execution result on record and
the brick log describes all six closed bricks.

## Brick 7 — elimination engine (scope, for approval after Phase 0)

Design intent, to be confirmed against the verified schema:

- Eliminations are **persisted, period-scoped, group-scoped entries**, generated
  by a server-side deterministic engine from declared intercompany
  relationships — never inferred from account names, never subtracted in the
  frontend.
- Sources in scope for this brick: reciprocal receivable/payable positions and
  intercompany revenue/cost recharges, both already identified by Brick 6.
- Each elimination carries: group, period, source member pair, source accounts,
  group accounts, rate class and rate used, amount in presentation currency,
  generating rule, and a reason. Asymmetric pairs are **not** silently netted —
  the disagreement is reported and blocks a clean elimination.
- Eliminations post into the consolidated statements as a distinct column, so
  the statement always shows combined, eliminations and consolidated separately.
- Reversible and re-generatable; superseding a generation never duplicates.
- Refuses rather than approximates: missing mapping, missing rate, one-sided
  declaration, or a disagreeing pair all stop the elimination and name the cause.
- Security: generation and viewing gated by `resolve_consolidation_scope`, so a
  user must be able to see every member in scope; `anon` gets no privileges on
  the new tables (this defect appeared twice already and both times on a newly
  created table).
- Delivered with an SQL suite (contract, behaviour, isolation) and an
  architecture ratchet asserting the client never eliminates anything itself.

Out of scope for Brick 7, and it will stay out: NCI, equity method, consolidated
cash flow, goodwill, unrealised profit in inventory. Nothing will be stubbed to
make the UI look complete.

## Technical notes

- New objects will follow the existing pattern: create table, GRANT to
  `authenticated` and `service_role` only, enable RLS, organization-scoped
  policies, guard trigger, change-log trigger reading the row from its `jsonb`
  image (the field-agnostic form that fixed the shared-trigger defect).
- No new FX resolver: rate selection continues through
  `consolidation_member_translation_rates` and `fx_rate_on`.
- No change to shared finance primitives without regression validation across
  their existing consumers.

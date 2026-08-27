# Consolidation — independent verification (2026-08-27, 11:5x UTC) and Brick 7

## What I verified myself, directly, this session

Against the live `AccrualFlowCorporation` database and the repo — not taken from
the previous engineer's notes:

- **Six consolidation tables exist and are secured.** `consolidation_groups`,
  `_group_members`, `_group_accounts`, `_account_mappings`,
  `_intercompany_partners`, `_group_change_log` all have row-level security
  enabled with policies attached (2 each; the append-only change log has 1).
- **The engine exists and is substantial.** Present as real database functions:
  scope resolution, member translation rates, member translation, translated and
  untranslated consolidated trial balance, statement lines, statement totals,
  CTA reconciliation, intercompany balances / activity / coverage, unmapped
  accounts, plus the guard and change-log triggers for every table.
- **Return contracts are genuine, not cosmetic.** The trial balance carries
  member, account, ownership and per-account balances; statements carry
  section/derived/residual structure and a presentation currency; intercompany
  balances carry both sides, both closing rates and the reciprocal difference.
  These are drill-down-capable shapes, not flat totals.
- **No elimination or consolidation-run objects exist anywhere** — no tables, no
  functions. Brick 7 and Brick 8 are genuinely unstarted.
- **Front end is real and routed.** `ConsolidatedTrialBalance`,
  `ConsolidatedStatements`, `ConsolidationIntercompany` and the legacy
  `Consolidation` comparative page all exist under Finance reports and are
  registered in the report registry and reports nav.
- **Seven SQL suites are committed** under `supabase/tests/` covering bricks 1–6,
  and they assert architecture, not just output — e.g. the intercompany suite
  fails the build if the function is `SECURITY DEFINER`, if it stops reading the
  AR/AP sub-ledger views, if it bypasses the group rate resolver or the scope
  gate, or if any rate is coalesced to 1.

Conclusion: the previous engineer's Phase 0 claim holds up structurally. The one
thing I cannot confirm from static inspection is the *execution* result of each
suite in this session, so Phase 0 re-runs them before any new code lands.

## Still genuinely outstanding

1. Brick 7 — elimination engine. Nothing exists.
2. Brick 8 — persisted, versioned consolidation runs. Nothing exists.
3. Brick 9 — ownership / non-controlling interest. Members carry an ownership
   basis, but there is no NCI presentation, which IFRS 10 requires.
4. Brick log sections for bricks 1, 2, 3 and 5 are still missing.

## Order of work

```text
Phase 0   Re-execute the six brick suites, confirm green, backfill the brick log
Brick 7   Elimination engine
Brick 8   Consolidation runs, versioning, audit trail
Brick 9   Ownership / NCI presentation
Brick 10  Consolidated cash flow (only if the primitives support it)
```

## Phase 0 — prove the base before building on it

Execute each committed suite against the live database, one at a time, recording
pass/fail per block. Every suite rolls back; residue is checked after each run.
Anything that fails is fixed in the engine when the engine is wrong, or in the
fixture when the fixture is wrong, and the log says which. Then backfill the
brick-log sections for bricks 1, 2, 3 and 5 from executed evidence only.

## Brick 7 — elimination engine (this brick's exact scope)

**Principle.** An elimination is a persisted, group-scoped, period-scoped,
deterministic adjustment derived from *declared* intercompany relationships and
the authoritative ledger — never inferred from account names or descriptions,
never subtracted in the browser.

In scope for Brick 7:

- Reciprocal intercompany receivable/payable positions (due-to / due-from).
- Intercompany revenue and matching cost recharges.

Explicitly **out** of scope for this brick, and left absent rather than stubbed:
unrealised profit in inventory, intercompany fixed-asset transfers, investment-
in-subsidiary versus equity elimination, and NCI allocation. Those belong to
later bricks and the schema will be shaped so they can be added without rework.

What gets built:

- **Elimination rule configuration** — per group: which elimination classes are
  active, which group accounts absorb the debit/credit, tolerance for reciprocal
  differences, and what happens when the two sides disagree beyond tolerance
  (refuse, or post the residual to a named difference account — configured, never
  silently chosen).
- **Elimination entries** — generated server-side, balanced by construction,
  each carrying: group, period, elimination class, both member businesses, both
  source accounts, group account, presentation-currency amount, the rate class
  and rate used, and the source evidence that produced it.
- **Deterministic generation function** — given group and period, produces the
  same set every time; reads only `consolidation_intercompany_balances` /
  `_activity` and the scope resolver; refuses on uncovered FX, out-of-scope
  members, unmapped accounts, and inverted date ranges, exactly as the existing
  engine refuses.
- **Reporting integration** — the consolidated trial balance and statements gain
  an *eliminations* column alongside the aggregated column, so a reader always
  sees pre-elimination, elimination and post-elimination side by side. The
  existing figures do not change meaning; nothing is quietly rewritten.
- **UI** — an eliminations view under Finance reports listing every elimination
  entry with its source pair, class, amounts and drill-down to the underlying
  positions, plus the group-level rule configuration in the consolidation
  configuration area.
- **Security** — same posture as the rest of the subsystem: organization-scoped
  RLS, `authenticated` and `service_role` grants only, no anon reads, and the
  generation function gated on the scope resolver so a user who cannot access
  every member cannot generate or read the group's eliminations.
- **Tests** — a committed SQL suite in the same style: reciprocal pair
  eliminated to zero, asymmetric pair handled per the configured policy,
  cross-currency pair eliminated at the correct rate class, out-of-scope member
  refused, cross-organization isolation, regeneration idempotent, and an
  architecture assertion that no elimination arithmetic lives in TypeScript.

**Exit condition.** For a group with declared intercompany relationships, the
consolidated statements show revenue and receivables net of intercompany
activity, every eliminated figure traces to its source pair and rate, and
regenerating the period produces an identical set.

## Technical notes

- New tables follow the established pattern: create, GRANT to `authenticated`
  and `service_role`, enable RLS, organization-scoped policies, guard trigger,
  change-log trigger reading the row from its `jsonb` image.
- No second FX resolver: rates continue to come from
  `consolidation_member_translation_rates` and `fx_rate_on`.
- No second accounting engine: eliminations consume the existing intercompany
  and translation functions, which in turn consume the authoritative finance
  primitives.
- Shared finance primitives are not modified in this brick.
- Test data may be seeded where the tenant does not supply a scenario; all suite
  fixtures roll back.

## Checkpoint

Brick 7 ends with a written record of what was established, what changed, what
was verified by execution, the accounting rules now enforced, the security
boundary, and what remains intentionally unimplemented. Brick 8 does not start
until that record exists.

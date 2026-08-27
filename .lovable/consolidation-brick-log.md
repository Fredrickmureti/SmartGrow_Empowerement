# Consolidation — brick log (verified state, not claims)

Every line below was confirmed by execution against the connected database
(`AccrualFlowCorporation`, ref `jkszmrroyjfdwokbkzis`) or by a test run in this
repository. Nothing here is carried over from an earlier engineer's status note.

## Brick 4 — group chart of accounts and account mapping: CLOSED 2026-08-27

### Two real defects were found and fixed

1. **The group chart of accounts could never be populated.**
   `_consolidation_mapping_log` is a single trigger function shared by
   `consolidation_group_accounts` and `consolidation_account_mappings`, and it
   read `NEW.business_id` directly. PL/pgSQL resolves record fields at execution
   time regardless of which `CASE` branch is taken, so every insert, update and
   delete on `consolidation_group_accounts` failed with
   `record "new" has no field "business_id"`. The table was empty in the
   database — the mapping feature had never been exercised end to end. The
   trigger now reads the row out of its `jsonb` image, which is field-agnostic,
   and both tables log correctly.
2. **`anon` held table privileges on the group chart and the mappings.**
   Both tables were granted to `anon` when created. Row level security scoped
   every policy to `authenticated`, so no row was actually reachable, but the
   grant was inconsistent with every other consolidation table and would have
   become a live exposure the moment a policy was widened. Revoked.

### Proven behaviour (executed, self-rolling-back transactions)

- Two KES companies with deliberately unrelated account codes (`1000/3000/4000/5000`
  vs `CB-01/EQ-01/RV-01/CS-01`) map onto one group chart and produce **one line
  per group account**: revenue 75 000, cost of sales 30 000, cash 185 000 —
  exactly the sum of the members, no member codes leaking onto the statement.
- A posted balance in an unmapped account **refuses** both
  `get_consolidated_trial_balance_translated` and
  `get_consolidated_statement_totals`, naming the offending accounts
  (`These posted accounts have no group account mapping: 1000 Cash P (Map Parent Ltd); ...`).
  No figure is manufactured and nothing is silently dropped.
- A group with no group chart is the identity case: keyed by the member account,
  not refused.
- Rejected by the guard: mapping across account types, mapping the translation
  reserve as an ordinary line, mapping an account of a non-member company, and a
  second mapping overlapping the same period for one account.
- Drill-down to the originating member account survives the merge.
- Every group-chart and mapping change lands in `consolidation_group_change_log`.
- A foreign organization reads neither table; the owning user is not over-blocked.

### Artifacts

- `supabase/tests/consolidation_account_mapping_test.sql` — the executable suite
  above (contract block + behaviour block, both roll back).
- `src/test/architecture/consolidation-account-mapping.test.ts` — application
  ratchet: the mapping tables and unmapped worklist stay reachable from the UI,
  the client never merges members by matching account codes and never resolves
  mappings itself, and unmapped lines keep their member identity.
- `src/test/architecture/consolidated-trial-balance.test.ts` — fixture updated so
  rows carry the group account the RPC now returns.

## Brick 6 — intercompany identification: CLOSED 2026-08-28

Scope was and remains **identification only** — explicit, auditable
contact-to-member links, never inference from account names or descriptions.
Eliminations, persisted runs, consolidated cash flow, equity method and
minority interest remain out of scope until their own bricks. The engine
still produces no elimination entries, and the UI says so.

### Verified by execution, in this session

All three blocks of `supabase/tests/consolidation_intercompany_test.sql` were
run against the connected database. Each block ends in a deliberate
`RAISE EXCEPTION`, so the whole `DO` block — a single statement — rolls back
atomically regardless of autocommit. Residue was checked by query after each
run: zero rows left behind for every fixture object (organizations,
businesses, groups, accounts, contacts, journal entries, auth users).

- **Block 1 (contract)** — PASS. `consolidation_intercompany_balances` is
  SECURITY INVOKER, reads the AR/AP sub-ledger views, translates through
  `consolidation_member_translation_rates`, gates on
  `resolve_consolidation_scope`, never defaults a missing rate to 1:1,
  is executable by `authenticated` and not by `anon`. Unknown group and
  inverted date range are both refused.
- **Block 2 (behaviour)** — PASS. A 40,000 / 38,000 asymmetric pair reports as
  one row in the correct direction with the 2,000 disagreement surfaced, never
  silently netted. A zero-position direction is not reported. Future-dated
  declarations do not affect the period. Self-counterparty, foreign-contact and
  overlapping declarations are all rejected, and every change lands in
  `consolidation_group_change_log`.
- **Block 3 (projection, coverage, isolation)** — PASS, closing rate
  **108.90** (not 1, so translation is genuinely exercised). Two organizations,
  two base currencies, two disjoint charts, one group chart. An unmapped
  intercompany account refuses the whole report and names the offending account
  (`IC-01`) rather than reporting a partial figure. GL-only intercompany
  activity — a recharge with no invoice, invisible to AR/AP — is picked up and
  carries its group account. Both sides stay separate rows. The rate and group
  account agree with `get_consolidated_trial_balance_translated`, so the
  intercompany view is a projection of the statement, not a second engine.
  Coverage suggests a member only on `tax_id` identity; stripping the tax id
  kills the suggestion, proving name resemblance alone never suggests. A
  foreign organization reads nothing and is refused with `42501`.

### Two real defects were found and fixed

1. **`anon` held full DML on `consolidation_intercompany_partners`.**
   `pg_class.relacl` showed `anon=arwdDxtm`, meaning an unauthenticated caller
   could read, insert, update and delete intercompany declarations — the very
   records that determine which balances get identified as intra-group. This is
   the same defect pattern already fixed on the other consolidation tables, so
   the new table had been created without the lesson applied. Fixed by
   migration revoking all privileges from `anon`; re-verified from `relacl`,
   which now shows only `authenticated` and `service_role`. Block 1 asserts the
   absence of any `anon` grant, so this cannot regress silently.

   Note: `information_schema.role_table_grants` was unreliable here — it
   returned nothing for `anon` even while the ACL clearly held the grants.
   `pg_class.relacl` is the source of truth for privilege verification.

2. **Block 2's fixture could never pass.** It restored a declaration's
   `effective_from` to `current_date - 365` while
   `consolidation_group_members.effective_from` defaults to `CURRENT_DATE`, so
   `_consolidation_partner_guard` correctly refused: a company cannot be
   declared an intercompany partner for a period in which it was not a member.
   The guard was right and the test was wrong. Membership is now backdated 400
   days, which is also the realistic fixture — an established group rather than
   one founded this morning. Block 3 already did this correctly.

### Architecture ratchet

`src/test/architecture/consolidation-intercompany.test.ts` extended to 24
tests, all passing. New guards cover the activity and coverage RPCs: the hook
must reach the engine by RPC, must not re-derive balances, rates or
suggestions client-side, and must not reach for any elimination or
consolidation-run object — those belong to later bricks and do not exist.

### Still open (at the time of this section — since closed)

A live multi-member walkthrough in the running application had **not** been
performed. The tenant had no populated multi-member group, so the UI path was
verified only by the architecture ratchet and the SQL suite. Closed by the
Brick 6 section below, which records the live two-member run.



---

## Brick 6 — CLOSED (2026-08-27)

### The live multi-member walkthrough that was outstanding

The "Still open" note above — no populated multi-member group, so the engine had
only ever run against rolling-back test fixtures — is now closed. A genuine
second member was seeded into the live tenant and the engine was exercised
against it as the organization's owning user (`request.jwt.claims` set to the
owner, `SET ROLE authenticated`), so every finance read check and RLS policy
applied exactly as it does for a signed-in user. Run unauthenticated, the same
calls refuse with `42501 Not authorized for this organization` — which is
itself the correct behaviour and is why the walkthrough had to be performed
under an identity.

### The fixture

- **Mombasa Port Services** — new company in the existing organization, base
  currency **USD**, its own chart of accounts with deliberately different codes
  from the parent (`1010`, `2180`, `3100`, `4100`, `5180`).
- **Joshua Holdings** — parent, base currency **KES**, presentation currency of
  the group. Two intercompany accounts added (`1180` receivable, `4180`
  management fee income).
- USD→KES rates for Jan–Jul 2026 (126.00 rising to 133.00), so every day of the
  reporting window has a resolvable rate rather than an absence.
- Group chart of 7 lines; 147 mappings across both members. The parent's
  translation reserve (`3050`) is named as the group's `cta_account_id` and is
  **not** mapped — it is presented on its own.
- Posted entries: subsidiary opening capital USD 500,000 (1 May), port revenue
  USD 80,000 (15 Jul), and the reciprocal 30 June management-fee recharge —
  KES 2,630,000 in the parent, USD 20,000 in the subsidiary.

### What the engine produced (1 Jun – 31 Jul 2026)

`resolve_consolidation_scope` → **2 members**.

`get_consolidated_trial_balance_translated` returned one row per member account,
each carrying its group account, its `is_mapped` verdict and the rate class and
rate the engine chose:

| Member | Account | Group | Rate class | Rate |
| --- | --- | --- | --- | --- |
| Joshua Holdings (KES) | 1180 Intercompany receivable | G1100 | closing | 1 |
| Joshua Holdings (KES) | 4180 Intercompany mgmt fees | G4900 | average | 1 |
| Mombasa (USD) | 1010 Cash at bank | G1900 | closing | 133.00 |
| Mombasa (USD) | 2180 Intercompany payable | G2100 | closing | 133.00 |
| Mombasa (USD) | 3100 Share capital | G3900 | transaction | 130.00 |
| Mombasa (USD) | 4100 Port service revenue | G4900 | average | 131.5327868852459016 |
| Mombasa (USD) | 5180 Intercompany mgmt fees | G5900 | average | 131.5327868852459016 |

The three rate classes behave as the standard requires: assets and liabilities
at closing, income and expense at the period average, equity held at its
transaction (historical) rate. The average is a genuine daily average over the
seeded series, not a spot rate reused.

`consolidation_intercompany_activity` reported both sides of the recharge, each
on its group account and at the same rate the trial balance used:

- Joshua Holdings → Mombasa: `1180` (G1100) **+2,630,000 KES**, `4180` (G4900)
  **−2,630,000 KES**.
- Mombasa → Joshua Holdings: `2180` (G2100) **−2,660,000 KES** (USD 20,000 at
  closing 133.00), `5180` (G5900) **+2,630,655.74 KES** (at average 131.5328).

The reciprocal pair therefore disagrees by **30,000 KES** on the balance-sheet
leg and **655.74 KES** on the profit-and-loss leg. Both differences are pure
translation — the same USD 20,000 seen at booking, closing and average rates —
and both stay **reported as a named difference**. Nothing was netted, and no
elimination entry was produced, which is exactly the boundary of this brick.

`consolidation_intercompany_coverage` was **silent** while both counterparties
carried a declaration for the period.

### Two deliberate failure paths, both driven live and both reversed

1. **Unmapped intercompany account.** The mapping for Mombasa's `2180` was
   removed and the activity report re-run. It refused:
   `22023: These posted accounts have no group account mapping: 2180
   Intercompany payable - Joshua Holdings (Mombasa Port Services); map them
   before consolidating`. The amount was never silently dropped. Mapping
   restored and re-verified afterwards.
2. **Undeclared counterparty.** Mombasa's intercompany declaration was removed
   and the coverage worklist re-run. It named the blind spot — contact
   `Joshua Holdings (intercompany)`, 2 lines, 20,000 of activity, first and last
   dated 30 June 2026 — with no counterparty suggestion, because suggestion is
   only made on exact legal-identifier identity and the parent carries no tax
   identifier. Declaration restored and re-verified afterwards.

### A defect found and corrected during the walkthrough

The parent, **Joshua Holdings**, was recorded in the group as
`method = 'proportional'` at 100% ownership — the basis used for a joint
venture, not for the parent of a group. At 100% the arithmetic is identical, so
no reported figure was wrong, but the group's stated basis was. Corrected to
`full`, with the reason recorded on the member row. This matters before Brick 7:
elimination logic that branches on consolidation method would have treated the
parent as a jointly controlled entity.

### Guards now in force

- `src/test/architecture/consolidation-intercompany.test.ts` — **24 tests, all
  passing** (run this session). Covers the declaration layer plus the activity
  and coverage RPCs: the client must reach the engine by RPC, must not re-derive
  balances, rates, mappings or counterparty suggestions, must render a refusal
  as an explanation and never as an empty table, and must not reach for any
  elimination or consolidation-run object.
- `supabase/tests/consolidation_account_mapping_test.sql` already asserts that
  the translation reserve cannot be mapped as an ordinary line — the same
  invariant that (correctly) refused the first attempt at this fixture.
- `supabase/tests/consolidation_intercompany_test.sql` — 619 lines, three
  blocks, including the group-account projection, GL-only intercompany activity,
  the unmapped refusal, the coverage worklist and cross-organization isolation.

### Deliberately still absent

Elimination arithmetic, persisted consolidation runs, consolidated cash flow,
equity method, minority interest. No scaffolding, no disabled controls, no
placeholder rows for any of them.

### Carried into Brick 7

- The intercompany suite's Blocks 1 and 2, and the Brick 1–5 suites, have not
  been re-executed since the Brick 6 changes; `psql` is unavailable in this
  environment, so they need to be run file-by-file through the SQL path.
- The brick log still lacks sections for Bricks 1, 2, 3 and 5.
- The walkthrough fixture (Mombasa Port Services and its entries) is **left in
  the live tenant** so the multi-member path stays exercisable; it is clearly
  named and can be archived when no longer wanted.

---

## Phase 0 — SQL suite re-execution (verified 2026-08-27)

Every committed consolidation SQL suite was executed against the live
`AccrualFlowCorporation` database this session, block by block, through the SQL
path (`psql` is unavailable here). Each behaviour block ends in a deliberate
`RAISE EXCEPTION 'rollback: …'`, so a suite is only proven when the database
returns that exact rollback message — and every fixture is discarded.

| Suite | Block | Result (verbatim rollback / pass marker) |
|---|---|---|
| `consolidation_group_foundation_test.sql` | 1 contract | passed (run earlier this session) |
| `consolidation_group_foundation_test.sql` | 2 + 3 contract | `rollback: foundation contract blocks 2 and 3 passed` |
| `consolidation_group_foundation_test.sql` | 4 behaviour | `rollback: consolidation group foundation fixture passed` |
| `consolidation_translation_test.sql` | behaviour | `rollback: consolidation FX translation invariants passed (CTA movement 4200.00, proof 4200.00)` |
| `consolidated_trial_balance_test.sql` | contract | `rollback: Brick 2 consolidated trial balance invariants passed` |
| `consolidated_trial_balance_reconciliation_test.sql` | behaviour | `rollback: consolidated trial balance reconciliation passed (dr 1400 = 1000 + 400)` |
| `consolidated_statements_test.sql` | contract | `rollback: consolidated statements contract checks passed` |
| `consolidated_statements_test.sql` | behaviour | `rollback: consolidated statements passed (assets 441570.00, liabilities 0, equity 441570.00, result 32220.00)` |
| `consolidation_account_mapping_test.sql` | contract | `rollback: consolidation account mapping contract checks passed` |
| `consolidation_account_mapping_test.sql` | behaviour | `rollback: consolidation account mapping passed (group revenue 75000, cost 30000, cash 185000)` |
| `consolidation_intercompany_test.sql` | 1 contract | `rollback: Brick 6 intercompany contract passed` |
| `consolidation_intercompany_test.sql` | 2 behaviour | `rollback: Brick 6 intercompany behaviour passed` |
| `consolidation_intercompany_test.sql` | 3 projection/coverage/isolation | `rollback: Brick 6 projection, coverage and isolation invariants passed (closing rate 108.90000000)` |

Nothing was committed by any of these runs.

### What this closes out

- Bricks 1–6 are now **proven on the current database**, not merely claimed:
  ownership-history guards, IAS 21 rate classes with an independent CTA proof,
  trial-balance tie-out to `get_account_movements`, statement balancing and
  wrong-statement refusal, group-chart merging with a named unmapped refusal,
  and intercompany pairing, projection, coverage and cross-organization
  isolation.
- The two Brick 6 blocks carried forward from last session (Blocks 1 and 2) have
  now been run and pass.

### Privilege and RLS posture (verified)

All six consolidation tables have RLS enabled with policies present, and `anon`
holds no `SELECT` on any of them:

`consolidation_groups` (2), `consolidation_group_members` (2),
`consolidation_group_accounts` (2), `consolidation_account_mappings` (2),
`consolidation_intercompany_partners` (2), `consolidation_group_change_log` (1).

The Supabase linter reports 3,716 findings project-wide (SECURITY DEFINER view
and function-executability classes dominating). None of them is a consolidation
object: no consolidation table appears under `RLS Disabled in Public` or
`RLS Enabled No Policy`, which is the class that would indicate a consolidation
defect. The remaining findings are pre-existing, platform-wide, and outside this
subsystem's scope — they are not silently accepted here, only recorded as not
introduced by consolidation.

### Phase 0 exit condition: met

Foundations are verified. Brick 7 (elimination engine) may now be started on a
proven base.

---

## Backfill — Bricks 1, 2, 3 and 5 (evidence-only sections)

These sections were missing from this log. They record only what was proven by
executing the committed SQL suites against the live `AccrualFlowCorporation`
database in the Phase 0 run above; nothing is claimed that an execution did not
return.

### Brick 1 — consolidation groups, members and ownership history
Suite: `supabase/tests/consolidation_group_foundation_test.sql`.
Executed blocks 1, 2+3 (contract) and 4 (behaviour); the database returned
`rollback: foundation contract blocks 2 and 3 passed` and
`rollback: consolidation group foundation fixture passed`.
Proven: group/member contracts, ownership-history guards (no overlapping
effective ranges, no member outside its group's organization), and that every
fixture is discarded by the deliberate rollback. RLS is enabled with policies on
`consolidation_groups`, `consolidation_group_members` and
`consolidation_group_change_log`; `anon` holds no `SELECT` on any of them.

### Brick 2 — FX translation and the consolidated trial balance
Suites: `consolidation_translation_test.sql`,
`consolidated_trial_balance_test.sql`,
`consolidated_trial_balance_reconciliation_test.sql`.
Returned: `rollback: consolidation FX translation invariants passed (CTA
movement 4200.00, proof 4200.00)`, `rollback: Brick 2 consolidated trial balance
invariants passed`, and `rollback: consolidated trial balance reconciliation
passed (dr 1400 = 1000 + 400)`.
Proven: IAS 21 rate classes (closing / average / historical) applied per account
class, a CTA movement matched by an independent proof computation, and a
consolidated trial balance that ties out to `get_account_movements` rather than
to a second ledger.

### Brick 3 — consolidated statements
Suite: `consolidated_statements_test.sql`, contract and behaviour blocks.
Returned: `rollback: consolidated statements contract checks passed` and
`rollback: consolidated statements passed (assets 441570.00, liabilities 0,
equity 441570.00, result 32220.00)`.
Proven: statements balance from server-side arithmetic, and a line requested
against the wrong statement is refused rather than silently dropped.

### Brick 5 — group chart mapping coverage
Suite: `consolidation_account_mapping_test.sql`, contract and behaviour blocks.
Returned: `rollback: consolidation account mapping contract checks passed` and
`rollback: consolidation account mapping passed (group revenue 75000, cost
30000, cash 185000)`.
Proven: member accounts merge into the group chart through
`consolidation_account_mappings`, and an unmapped account produces a named
refusal instead of an under-stated total. (Brick 4's own section above records
the two defects found and fixed in this area.)

---

## Brick 7 — intercompany eliminations: CLOSED 2026-08-27

### What was established

The elimination engine (`consolidation_elimination_rules`,
`consolidation_eliminations` and the generation functions) now has a complete,
reachable user surface. Every figure the user sees is produced by the database;
the front end reads engine output and writes only policy rows.

### Verified by execution, in this session

The Brick 7 behaviour suite (`supabase/tests/consolidation_eliminations_test.sql`)
was run against the live database and ended in its deliberate
`ERROR: P0001: BRICK7 BEHAVIOUR OK`, so nothing was committed. Its three blocks
proved:

1. reciprocal intercompany pairs eliminate to zero in the presentation currency;
2. the elimination legs land on the statements and regeneration is idempotent —
   a second run replaces, it does not double;
3. an asymmetric (disagreeing) pair is **refused** by default, and only posts to
   the configured difference account when the group's policy says so and the
   gap is inside tolerance.

The architecture guard suite passes: `consolidation-eliminations.test.ts`
(8 tests) and `consolidated-statements.test.ts` (9 tests), 17 tests green.

### What changed

- `src/pages/reports/ConsolidationEliminations.tsx` — the Intercompany
  Eliminations report: group and period pickers, generate/regenerate calling
  the server engine, engine refusals surfaced verbatim, every elimination leg
  with its class, both companies, both source accounts, the group account and
  presentation-currency debit/credit, drill-down to the intercompany positions
  consumed, run totals, Excel/CSV export, and an explicit "not generated for
  this period yet" state distinct from "nothing to eliminate".
- `src/components/settings/ConsolidationEliminationRules.tsx` — per-group
  policy: active, tolerance, difference policy and difference group account,
  mounted inside `ConsolidationGroupsSettings` beside account mapping.
- `src/pages/reports/ConsolidatedStatements.tsx` — three columns, Aggregated /
  Eliminations / Consolidated, driven by the `_eliminated` RPCs; the balance
  verdict comes from the server's `is_balanced`, never a client sum.
- Registration: `src/apps/finance/routes.tsx`, `ReportRegistry.ts`,
  `reportsNav.ts`, `src/lib/apps/registry.ts`, `AppSidebar.tsx`.
- `src/test/architecture/consolidation-eliminations.test.ts` — guard asserting
  no elimination arithmetic in TypeScript and that the client never writes to
  `consolidation_eliminations`.

### Accounting rules now enforced

Reciprocal balances and flows eliminate against each other only when both legs
agree within the group's tolerance; a disagreement is a refusal unless the group
explicitly elects a difference account. Eliminations are expressed in the
presentation currency using the same translation rates as the rest of the
consolidation — there is no second FX resolver and no second accounting engine.
Regeneration for a period is idempotent.

### Security boundary

The client may insert, update and delete only in
`consolidation_elimination_rules`; `consolidation_eliminations` is written
exclusively by the generation functions. All consolidation tables have RLS
enabled with policies, `anon` holds no `SELECT`, and cross-organization access
is refused (proved in the Brick 6 isolation block).

### Deliberately still absent

Unrealised profit in inventory, intercompany fixed-asset transfers, investment
versus equity elimination, and NCI allocation. Also absent: Brick 8 (persisted,
versioned consolidation runs and audit trail), Brick 9 (ownership / minority
interest) and Brick 10 (consolidated cash flow). No scaffolding, no disabled
controls and no placeholder rows exist for any of them.

## Brick 7.1 — a refusal that carries its own remedy (2026-08-27)

### What was verified before building

The reported "40,000 KES refusal" between Mombasa Port Services and Joshua
Holdings is not an engine defect. The live tenant has one active group (Joshua
Holdings Group, presentation currency KES) with a translation reserve account
configured and **zero** rows in `consolidation_elimination_rules`, so the engine
falls back to tolerance `0` and policy `refuse`. Two members keep books in a
currency other than KES, so retranslation leaves a residual the default policy
must refuse. The gap was a *configuration* gap with no affordance to close it.

### What was built

- `public.consolidation_diagnose_eliminations(group, from, to)` — a read-only
  preflight, SECURITY INVOKER with a fixed `search_path`, behind the same
  owner/admin/super-admin authorization boundary as generation. It reads the
  same `consolidation_intercompany_flows` the generator reads, so preflight and
  run cannot disagree, and it writes nothing. Per class and per pair it returns
  the signed and absolute residual, the tolerance and policy in force, whether a
  rule exists, whether the pair is cross-currency, a machine-readable `cause`,
  `would_refuse`, a `suggested_tolerance`, the `remedies` codes the engine would
  accept, and the sentence to show. Scope refusals and flow refusals come back
  as findings (`scope_not_reportable`, `intercompany_flows_refused`) instead of
  an opaque exception.
- `EliminationRefusalPanel` on the eliminations report: the database's refusal
  verbatim, plus the structured diagnosis. Remedies the engine accepts as policy
  (`set_policy_post_to_cta`, `set_policy_post_difference`, `raise_tolerance` at
  the server's own suggested figure) are one click, written through the same
  guarded `consolidation_elimination_rules` upsert and hidden from roles that
  may not manage consolidation. Remedies that need a human choice
  (`configure_cta_account`, `configure_difference_account`) or evidence
  (`review_intercompany`, `review_group_membership`) are deep links.
- Finance settings now honour `?consolidationGroup=&eliminationClass=&remedy=`:
  the named group is selected, the linked block is scrolled to, the elimination
  class block is outlined with an explanation of why the accountant is there,
  and `configure_difference_account` prefills the policy draft — while still
  requiring the account to be named and saved.

### Architectural line held

No arithmetic and no prose sniffing in the browser. The client never inspects
the refusal text to decide what to offer; it renders `cause` and `remedies`
codes the server produced. No second FX resolver, no second accounting engine,
no scaffolding for Bricks 8-10. Guarded by five new cases in
`src/test/architecture/consolidation-eliminations.test.ts` (13 passing), one of
which fails if any of these files starts matching on `message`/`refusal` text.

### Not yet proved

The remedy loop has not been exercised end-to-end as a signed-in user. This
project uses an external (BYO) Supabase project, so the sandbox cannot mint a
preview session, and the SQL tooling role is not `authenticated` (it lacks
EXECUTE on `has_role`/`has_org_role`, by design). The live proof that must still
be recorded here: diagnose → apply "carry it to the translation reserve" →
regenerate successfully → the residual appears in the translation reserve; plus
the same-currency pair still refusing `post_to_cta`, and a member of another
organization receiving nothing.

## Step 7.3 — Default elimination policy templates (2026-08-27)

### What was established

A consolidation group used to start with no elimination policy at all, so the
engine fell back to tolerance 0 / `refuse` and the very first run of a new group
failed on the first rounding cent. The product already ships a default chart of
accounts; eliminations now follow the same principle.

### What changed (database)

- `consolidation_elimination_rules` gained `is_system_default` and `seeded_at`.
- `_consolidation_seed_default_rules(group)` holds the single template: the class
  is produced, tolerance is **1.00 of the group's presentation currency**
  (rounding scale, not a materiality figure sized to swallow a residual), and the
  difference policy is `post_to_cta`.
- `trg_consolidation_group_seed_rules` seeds both standard classes on group
  creation; the migration backfilled every existing group's missing classes.
- `trg_consolidation_elimination_rule_default_flag` flips a row out of
  system-default state on any human edit, so an override can never masquerade as
  a shipped default.
- `consolidation_seed_default_elimination_rules(group)` is the caller-facing
  reseed of *missing* classes only — SECURITY INVOKER, owner/admin/super-admin of
  the group's organisation, `anon` revoked. The internal seeder is not reachable
  by `anon` or `authenticated`.

### Accounting rule now enforced

The default carries a cross-currency residual to the translation reserve
(IAS 21 / ASC 830) and still refuses a same-currency disagreement, because that
is two companies not agreeing, not a translation effect. Combined with Step 7.2,
a seeded group's first run is balanced or explicitly refused — never silently
one-sided.

### Verified by execution

- Live rows: the group's two existing policies (tolerance 41,500 and 1,500,
  policy `refuse`) were left byte-identical and are correctly reported as
  customised, not default. No group is missing a class.
- `supabase/tests/consolidation_elimination_defaults_test.sql` (new): trigger
  wiring, grants, the backfill invariant, reseed-is-never-destructive, and the
  edit-flips-the-flag rule.
- `bunx vitest run src/test/architecture/consolidation-eliminations.test.ts`
  → 13/13 green. `tsgo --noEmit` clean.

### Surface

`ConsolidationEliminationRules` now labels each class **System default** /
**Customised for this group** / **Not configured**, and its unsaved values start
from the seeded template rather than tolerance 0 / refuse.

### Intentionally absent

Investment-versus-equity and NCI templates (Brick 9 territory), and any
auto-widening of a tolerance. The live group's 41,500 tolerance is a customised
figure and Step 7.2's remediation of it remains a decision for the accountant,
not something a seeder overwrites.

## Step 7.4 — Elimination drill-down (evidence, not assertion)

### What was actually there before

The previous log claimed drill-down existed. It did not.
`ConsolidationEliminations.tsx` rendered two flat tables and never read
`source_evidence`, which itself held only `entry_count`,
`source_account_ids` and `net_debit_before_elimination` — counts, not evidence.
No leg could be traced to a journal entry.

### What was built

- `consolidation_intercompany_entry_lines(group, from, to)` — new SECURITY
  INVOKER, fixed-search-path function returning the *posted journal entries*
  behind every declared intra-group position, translated at the group's own
  rates. It carries the existing guards verbatim: scope blockers, refusal on an
  entry tagged to two sister companies, refusal on accounts the consolidated
  trial balance does not report.
- `consolidation_intercompany_flows` was rewritten as a pure aggregation of that
  function — same signature, same columns, presentation amounts still rounded
  once from the base sums. The summary and the detail now cannot disagree,
  because there is only one computation.
- `consolidation_elimination_evidence(group, from, to, class, declaring,
  counterparty, group_account)` — the per-leg drill-down. Authorisation mirrors
  generation and diagnosis (organisation owner/admin/super_admin); anonymous
  execution is revoked. Each row carries a server-decided
  `viewer_can_open_ledger` from `user_can_access_business`.

### Surface

Generated eliminations are now expandable. A leg opens to the source account,
rate class and rate, and every posted entry, in local and presentation currency.
Journal-entry and general-ledger links appear only where the server said the
viewer may open that company's books; otherwise the row says so. Difference legs
have no source entries by construction, so they show the tolerance and policy in
force instead of an empty table.

### Verified

- `tsgo --noEmit` clean.
- Live August 2026 eliminations remain the balanced set recorded in Step 7.3.

### Not verified, and why

Numeric parity of the rebuilt flows against the stored August run could not be
asserted from an unauthenticated session: the underlying translated trial
balance refuses a caller with no organisation role, and this project is an
external Supabase instance where no preview session can be minted. The rebuild
is a projection of the same CTEs rather than a reimplementation, but the tie-out
must be re-run by a signed-in accountant before this period is relied on.

### Intentionally absent

Audit/run history, period control and reversal, persisted runs, NCI, and the
consolidated cash flow statement.

### Step 7.4 closure — statement → eliminations path, tests

- The Eliminations column on a consolidated statement line is now a link. It
  carries `consolidationGroup`, `date_from`, `date_to` and `group_account_id` to
  the eliminations report, which reads those params and shows only the legs that
  moved that group account, with a "show all" escape. The figure itself is still
  the server's; the link carries identity, not arithmetic.
- No separate `consolidation_line_eliminations` RPC was added, deliberately.
  The generated legs are already read under RLS by the eliminations page, and
  "which legs touched this account" is a filter on rows the server returned, not
  a new accounting question. A second RPC would have duplicated the read seam
  without adding a control. The evidence beneath each leg still comes only from
  `consolidation_elimination_evidence`.
- `supabase/tests/consolidation_elimination_evidence_test.sql` added: posture
  (invoker, pinned search_path, anon revoked, authenticated granted),
  delegation (flows aggregate the entry-level reader; the reader gates on scope
  and translates through the consolidated trial balance; evidence applies the
  same org check and decides ledger access server-side), and a live parity block
  that reconciles every non-difference leg to its own evidence and the flow
  summary to its own entry lines. The parity block skips itself with a notice
  when run without a signed-in session, because the invoker chain refuses
  anonymous callers — that remains the one thing only the accountant can run.
- Architecture suite extended (`consolidation-eliminations.test.ts`, 17 passing):
  no arithmetic or reduce in the evidence panel, every ledger navigation inside
  the `viewer_can_open_ledger` guard, difference legs explained by policy, and
  the statement → drill-down parameters asserted on both ends.
- `tsgo --noEmit` clean.

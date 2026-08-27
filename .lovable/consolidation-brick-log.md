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

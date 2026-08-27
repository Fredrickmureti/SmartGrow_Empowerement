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

### Still open

A live multi-member walkthrough in the running application has **not** been
performed. The tenant has no populated multi-member group, so the UI path is
verified only by the architecture ratchet and the SQL suite, not by observing
a real group render in the browser.


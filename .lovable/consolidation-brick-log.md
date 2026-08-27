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

## Next — Brick 6: intercompany identification only

Confirmed absent from the database: any intercompany, elimination,
related-party, trading-partner or persisted consolidation-run table. Available
ledger hooks: `journal_entry_lines.contact_id`, `contacts.business_id`,
`contacts.commercial_partner_id`, `contacts.parent_contact_id`.

Scope stays **identification only** — explicit, auditable contact-to-member
links, never inference from account names or descriptions. Eliminations,
persisted runs, consolidated cash flow, equity method and minority interest
remain out of scope until their own bricks.

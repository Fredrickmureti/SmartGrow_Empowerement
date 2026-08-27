# Consolidation — verified handover (2026-08-27, 10:4x UTC): closing Brick 6 in live data

Supabase project `AccrualFlowCorporation` (ref `jkszmrroyjfdwokbkzis`) is already connected. No connection work is needed.

Everything in Phase 1 below was re-derived this session from the repository and the live database. The previous plan text was treated as unverified — and two of its claims turned out to be stale.

## Phase 1 — verified current state

### Confirmed genuinely present

- **Bricks 1–5 engine and Brick 6 database surface exist.** Group foundation, translation, trial balance, statements, account mapping and the three intercompany RPCs (`consolidation_intercompany_balances`, `_activity`, `_coverage`) are all in the database, INVOKER-rights, granted to `authenticated` and `service_role` only.
- **Brick 6 application surface exists.** `src/hooks/finance/useConsolidationIntercompany.ts` and `src/pages/reports/ConsolidationIntercompany.tsx` render declarations, reconciliation and the coverage worklist.
- **The intercompany SQL suite is complete and was executed.** `supabase/tests/consolidation_intercompany_test.sql` is 626 lines across three blocks. The brick log records all three blocks PASS, including the unmapped-account refusal, GL-only intercompany activity, tax-id-only coverage suggestion, and cross-organization refusal (`42501`), at a genuine closing rate of 108.90.
- **The architecture ratchet WAS extended** — contrary to the previous plan's "Confirmed still open" note. `src/test/architecture/consolidation-intercompany.test.ts` (220 lines) already asserts the activity and coverage RPCs in both the hook and the generated types, the group-account columns on the page, and that the client never re-derives mappings or balances.
- **The brick log has a Brick 6 section**, marked CLOSED 2026-08-28, with one item explicitly still open.

### Confirmed still open

- **Consolidation has never run against more than one member in live data.** The tenant holds 1 group (`Joshua Holdings Group`, presentation currency KES), **1 member, 0 group accounts, 0 mappings, 0 intercompany declarations**. Every multi-entity proof exists only inside rolling-back test transactions.
- **The seed attempted last session did not land.** It aborted as one transaction when `_consolidation_mapping_guard` refused to map the parent's translation reserve (`3050 Foreign Currency Translation Reserve`) to a group account. The guard was right: the CTA is computed by the translation engine and presented on its own line, so mapping a manually posted reserve would double-count it. Nothing partial was written.
- **The FX rate series the walkthrough needs does not exist.** `exchange_rates` holds USD→KES only for 2026-08-12 .. 2026-08-27. The June–July 2026 closing/average/historical rates the walkthrough depends on must be seeded.
- **There is no second member business to consolidate.** Only two businesses exist and they sit in **different organizations**, so a subsidiary must be created inside the parent's organization (`8e682296-…`) with a USD base currency.
- **The CTA-mapping invariant is protected only by a trigger**, not by a test. Nothing in the ratchet asserts it.
- **Brick 7 does not exist in any form** — zero elimination functions, zero elimination or consolidation-run tables. Correct at this stage.

So Brick 6 is code-complete and SQL-proven, but not proven in the running application. Brick 6 stays open until it is, and Brick 7 does not start before that.

## Phase 2 — corrections carried into the plan

- Status claims are re-derived from the repository and database at the start of every session, never copied forward. Two of the last plan's "still open" items were already done; that failure mode is what this rule exists for.
- The group chart carries **no CTA slot**. The translation reserve is engine output, presented on its own line. The seed must not create `G-3900` or map `3050`.
- One accounting truth: intercompany and consolidated figures stay projections of `get_consolidated_trial_balance_translated`. No second rate resolver, no browser arithmetic.
- Seeding live fixture data is permitted where the tenant genuinely lacks it, and it must be realistic: a backdated group, a real rate series, and a deliberately asymmetric intercompany recharge so a real difference surfaces rather than a tidy zero.
- Migrations stay small and single-purpose. SQL suites run one file at a time, never batched.

## Work order — Brick 6 closure

### Step 1 — correct and land the multi-member seed

One migration, idempotent, in the parent's organization:

- Subsidiary business `Mombasa Port Services`, base currency **USD**, with a small distinct chart (different codes from the parent, proving mapping is doing real work).
- USD→KES rate series across 2026-05-01 .. 2026-07-31 so a closing rate (2026-07-31), a period average and a historical rate (2026-05-15) all resolve from the existing rate book — no `COALESCE(rate, 1)` anywhere.
- Group chart of accounts for `Joshua Holdings Group` and explicit mappings from both members' accounts. **No CTA group account, no `3050` mapping.**
- Membership: subsidiary added `full` at 100%, backdated so it is an established group. Parent membership changed from `proportional` to `full` — identical numbers at 100% ownership, but `full` is the correct method for a parent.
- Opening balances and period activity on both members, including a deliberately asymmetric intercompany recharge (KES 600,000 on the parent against USD 4,500 on the subsidiary) booked to GL, plus one intercompany AR/AP pair.
- One intercompany partner declaration, and one counterparty left **undeclared** so the coverage worklist has something real to surface.

### Step 2 — verify the seed by query

Confirm the closing rate at 2026-07-31 and the historical rate at 2026-05-15 resolve to the seeded values, that translation therefore produces a non-zero CTA, and that `consolidation_unmapped_accounts` is empty for the group.

### Step 3 — live multi-member walkthrough

Drive `Joshua Holdings Group` for June–July 2026 through group settings, account mapping, consolidated trial balance, consolidated statements and the intercompany page in the running application. Record what was observed, including:

- the CTA line arriving from the engine, not from a mapped account;
- the asymmetric recharge reported as a named difference, never netted;
- the undeclared counterparty appearing in coverage;
- one deliberate unmapped-account refusal rendered as an explanation, not an empty table.

### Step 4 — ratchet the CTA-mapping invariant

Add an assertion (SQL suite plus architecture ratchet) that the group's CTA account cannot be mapped to a group account, so the invariant is protected by test and not only by trigger.

### Step 5 — regression pass and brick log

Run, one file at a time: `consolidation_group_foundation_test.sql`, `consolidation_translation_test.sql`, `consolidated_trial_balance_test.sql`, `consolidated_trial_balance_reconciliation_test.sql`, `consolidation_account_mapping_test.sql`, `consolidated_statements_test.sql`, `consolidation_intercompany_test.sql`. Record pass/fail per file, then update the Brick 6 section of the brick log with the walkthrough result and close it.

### Checkpoint

Stop after Step 5 and report: what was established, what changed, what was verified, which suites ran, and what remains deliberately absent. Brick 7 (eliminations) begins only after that report.

## Explicitly out of scope until Brick 6 closes

Elimination arithmetic, persisted consolidation runs, consolidated cash flow, equity method, minority interest. No TODO scaffolding and no disabled controls for any of them.

## Technical notes

- Grants on any new object: `authenticated` and `service_role` only; never `anon`. Verify from `pg_class.relacl` — `information_schema.role_table_grants` has already proven unreliable here.
- Seeded fixture data stays in the live tenant deliberately (it is the walkthrough evidence) and is clearly named; SQL suite fixtures continue to roll themselves back.
- Contact-to-business scoping uses `contacts.business_id` / `contacts.organization_id`; `commercial_partner_id` and `parent_contact_id` stay contact-hierarchy concerns.

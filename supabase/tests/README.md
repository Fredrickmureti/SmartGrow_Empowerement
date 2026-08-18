# SQL invariant suites

These files assert invariants that only the database can prove: privilege
grants, `SECURITY DEFINER` seams, trigger behaviour, concurrency indexes and
refusal codes. They complement the architecture ratchets under
`src/test/architecture/`, which assert the *shape* of the code but cannot
execute a transaction.

## Running them

They run against a Postgres instance with the project's migrations applied —
a local Supabase stack or a scratch branch database, never production:

```bash
supabase start           # once, boots the local stack
supabase db reset        # applies supabase/migrations from scratch
supabase test db         # runs every *_test.sql in this directory
```

A single suite:

```bash
supabase test db --file supabase/tests/bank_account_lifecycle_invariants_test.sql
```

Each file is self-contained: it seeds its own fixtures inside a transaction and
rolls back, so order does not matter and a failed run leaves no residue.

## Banking suite

| File | Invariants |
| --- | --- |
| `bank_account_lifecycle_invariants_test.sql` | Illegal transitions refused, `row_version` conflicts, activation needs a GL account, opening balance posts once and reverses through the engine, draft-only deletion (ADR-0145) |
| `bank_statement_ingestion_invariants_test.sql` | One ingestion engine: dedup by fingerprint / `external_transaction_id`, locked period → `rejected_rows`, non-active account refused, currency mismatch rejected |
| `bank_reconciliation_lifecycle_invariants_test.sql` | One open session per account, cross-account and post-dated lines refused, write-off threshold, completion balance gate, cancel keeps provenance |
| `bank_matching_seam_invariants_test.sql` | Propose → confirm, allocation totals, over-allocation and cross-company refusal, fee residual posting (ADR-0123) |
| `bank_feed_transport_invariants_test.sql` | Run concurrency index, health transitions, idempotent finish/fail, legacy sync columns absent (ADR-0143) |
| `bank_ownership_invariants_test.sql` | Organization / business / branch coherence across the banking family |
| `banking_privilege_ratchet_test.sql` | No `anon` or `PUBLIC` privilege on any banking table or function; `authenticated` holds `SELECT` only |

## Adding a suite

One file per invariant class, named `<domain>_<concern>_test.sql`. Assert the
refusal (the error code raised), not only the happy path — a seam that accepts
valid input is unremarkable; a seam that refuses invalid input is the contract.

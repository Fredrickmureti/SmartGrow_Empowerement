# Bank Import — `22003 bigint out of range` root cause

## What actually happens

The import RPC no longer fails on statement status (that class is fixed). It now fails inside the
server-side duplicate fingerprint.

For every row, `bank_statement_import_batch` calls `bank_transaction_fingerprint(...)` because the
browser does not send `external_transaction_id`. That function is a hand-rolled FNV hash written in
`bigint` arithmetic:

```text
h2 := ((h2 # c) * 2166136261) % 4294967296
```

The modulo is applied **after** the multiplication. `h2` can be any value up to 4 294 967 295, and
`4294967295 * 2166136261 = 9.30e18`, which is larger than the bigint ceiling `9.22e18`. Postgres
raises `22003 bigint out of range` before the `%` ever runs.

Confirmed directly against the database: `select 4294967295::bigint * 2166136261` returns
`ERROR: 22003 bigint out of range`. The largest `h2` that survives the multiply is 4 257 759 839, so
roughly 0.9% of characters blow up — over a fingerprint string of ~120 characters (account UUID,
date, description, amount, reference) the odds of at least one overflow are around 60%. That is why
some files import and this one dies: it depends on the exact description text.

The sibling line for `h1` uses the multiplier 16 777 619, whose worst-case product is 7.2e16 — safely
inside bigint. Only the `h2` pass is defective.

## Repair

1. **Fix `bank_transaction_fingerprint`** so the multiply cannot overflow: perform the multiply in
   `numeric` (or reduce the operand first) and cast back after the modulo, for both passes:
   `h2 := (((h2 # c)::numeric * 2166136261) % 4294967296)::bigint`. This changes no output value —
   the mathematical result of the existing expression is preserved for every input that did not
   error — it only removes the overflow. The function stays `IMMUTABLE`.

2. **Align the character domain with the client.** SQL `ascii()` returns a Unicode code point while
   the browser's `charCodeAt` returns a UTF-16 code unit. For BMP text they agree; for emoji or
   other astral characters in a description the two fingerprints diverge, so the preview duplicate
   count would disagree with the server. Fold code points above 0xFFFF into their UTF-16 surrogate
   pair in SQL so both sides hash identically.

3. **Regression guard (pgTAP).** A test that fingerprints a set of adversarial descriptions —
   including one crafted to drive `h2` into the overflow band, long text, and non-ASCII — and
   asserts the function returns a 20-character `imp_` value instead of raising. Plus an equivalence
   test that the SQL fingerprint matches the JS `generateTransactionHash` output for a fixed vector.

4. **Vitest vector test** on `generateTransactionHash` pinning the same fixed vector, so the two
   implementations cannot drift apart silently in future edits.

## Blast radius

- `bank_transactions` currently holds 0 rows and 0 `imp_`-prefixed fingerprints, so there is no
  historical fingerprint to preserve; no backfill or dedupe migration is needed.
- No change to the statement lifecycle, journal posting, reconciliation, RLS or grants.
- `bank_statement_import_batch` itself is untouched — the fault is entirely in the helper it calls.

## Technical notes

- Files/objects changed: DB function `public.bank_transaction_fingerprint` (migration), one pgTAP
  test file, one vitest test file. No React changes.
- The client's `generateTransactionHash` is only used for the preview duplicate count; the server
  fingerprint is the system of record and remains authoritative.

# Accounting Engine — Final Audit & Architecture Reference

_Last verified: 2026-04-18 (forensic audit pass)._

This document is the authoritative reference for how journal entries
get into and out of the books in this system. It supersedes all earlier
notes in `.lovable/plan.md`.

---

## 1. Single-writer architecture (verified)

There are **exactly two** RPCs that may mutate the books. Every other
piece of code in the repo — client hooks, edge functions, database
triggers — funnels through one of these two.

| RPC | Purpose | Arity | Idempotency mechanism |
|---|---|---|---|
| `post_journal_entry_atomic` | Create + post a JE (with lines) in one transaction | 15 args | In-RPC pre-check on `(org, source_type, source_id, source_subtype)` + `idx_journal_entries_source_unique` |
| `void_journal_entry_atomic` | Reverse a posted JE by inserting mirror lines and flipping status to `'reversed'` | 5 args | In-RPC short-circuit returns existing reversal id; same unique index covers the `reversal` row |

`accounts.current_balance` is **never** written by application code. It
is mutated only by the two triggers described in §3.

---

## 2. Posting entry-point inventory

Every place a journal entry can originate. All paths terminate at
`post_journal_entry_atomic`.

| Caller | Layer | Path |
|---|---|---|
| `useGLPosting.postToGL` | client hook | direct RPC |
| `confirmInvoiceGL` (revenue + COGS legs) | client | via `postToGL` |
| `confirmBillGL` | client | via `postToGL` |
| POS shift close | DB trigger `trg_pos_shift_close_journal` → `post_pos_shift_gl` | server, RPC |
| `post-payroll-gl` | edge function | direct RPC |
| `process-recurring-invoices` | edge function | direct RPC |
| `run-depreciation` | edge function | direct RPC |
| `ConnectBankDialog` opening balance | client | direct RPC |

Every place a journal entry can be reversed. All paths terminate at
`void_journal_entry_atomic`:

`useVoidJournalEntry`, `useTransactionReversal`,
`useJournalEntries.createReversingEntry`, `useBills.voidBill`,
`useExpenses` (×2), `useBankTransactions`, `confirmBillGL` (rollback),
`reverse-payroll` edge function.

There are **no legacy pathways** still firing. `postInvoiceToGL` no
longer exists. There is no `post-pos-session-gl` edge function. No
client code performs `journal_entries.update({status: ...})` outside
the canonical void RPC.

---

## 3. Trigger interaction (the part that's easy to break)

```
                      ┌──────────────────────────────┐
   POST flow:         │ post_journal_entry_atomic    │
                      │  ↓ inserts JE (status=posted)│
                      │  ↓ inserts JE lines          │
                      └──────────────────────────────┘
                                 │
                                 ▼
        trg_update_account_balance_on_je_line  (per line, INSERT)
        — fires only when parent JE.status = 'posted'
        — applies +debit / +credit (signed by account_type)


                      ┌──────────────────────────────┐
   VOID flow:         │ void_journal_entry_atomic    │
                      │  ↓ inserts mirror lines      │  ← line trigger applies the offset NOW
                      │  ↓ updates original JE       │
                      │     status: posted→reversed  │  ← status trigger NO-OPS for this transition
                      └──────────────────────────────┘
```

### Why the status trigger no-ops for `posted → reversed`

The mirror-line INSERTs already moved balances by `−Δ`. If the
status trigger ALSO subtracted on `reversed`, balances would land at
`−2Δ`. The trigger body explicitly checks for the `reversed` target
and returns. This is verified live and locked by test **T-A**
(`voidDoubleCount.test.ts`).

`posted → voided` is different — it DOES subtract, because in the
voided path no mirror lines exist.

---

## 4. RPC contracts (argument names are part of the contract)

Renaming any of these arguments is a breaking change for every caller.
Test **T-F** (`voidRpcContract.test.ts`) probes both RPCs and fails
loudly if PostgREST returns `PGRST202` (signature mismatch).

### `post_journal_entry_atomic`
```
_organization_id  uuid
_entry_date       date
_description      text
_source_type      text
_source_id        uuid
_source_subtype   text          -- NULL is treated as 'main' by the unique index
_entry_number     text          -- pass NULL to auto-generate
_reference_number text
_business_id      uuid
_user_id          uuid
_lines            jsonb         -- [{account_id, debit, credit, description}, ...]
_auto_post        boolean       -- true = create as posted, false = create as draft
_idempotency_key  text
_metadata         jsonb
```

### `void_journal_entry_atomic`
```
_entry_id       uuid
_reason         text
_user_id        uuid
_entry_number   text   -- pass NULL to auto-generate the reversal entry number
_reversal_date  date   -- NULL = today
```

⚠️ The previous `reverse-payroll` edge function passed
`{_je_id, _voided_by, _void_reason, _create_reversal, _reversal_date}`
which silently failed with `PGRST202`. Fixed in defect **D-14**.

---

## 5. Idempotency boundary

Unique partial index on `journal_entries`:
```
idx_journal_entries_source_unique
  ON (organization_id, source_type, source_id, COALESCE(source_subtype, 'main'))
  WHERE status <> 'voided'
```

This means:
- One business event = one row keyed by `(org, source_type, source_id, subtype)`.
- An invoice with COGS posts TWO rows: one with `subtype = NULL` (main) and one with `subtype = 'cogs'`.
- `'reversal'` is itself a subtype, so reversals get their own slot.
- Voided rows are excluded so a void-then-repost cycle is allowed.

Combined with the in-RPC short-circuit, duplicate posts are
**structurally impossible** — even under network retries, double
clicks, or parallel calls.

---

## 6. Nightly integrity cron

`accounting_integrity_reports` is populated nightly by the
`check_balance_integrity` RPC. Read it like this:

```sql
select ran_at, has_drift, total_abs_drift, balance_drifts_count,
       ar_drift, ap_drift, details
from accounting_integrity_reports
order by ran_at desc
limit 14;
```

- `has_drift = false` for every recent row ⇒ books are clean.
- `details` contains an array of `{account_id, code, name, expected, actual, drift}` rows for any drift found.
- A non-zero `ar_drift` / `ap_drift` means the AR or AP control account
  no longer ties to the open documents — investigate before posting
  more transactions in that org.

---

## 7. Test suite

Located in `supabase/functions/_shared/__tests__/`.

| Test | What it pins |
|---|---|
| `voidDoubleCount.test.ts` (T-A) | Trigger interaction: void must net to baseline |
| `voidIdempotency.test.ts` (T-B) | Two parallel voids → one reversal |
| `posShiftMissingAccount.test.ts` (T-C) | POS shift fails fast on missing account; idempotent on retry |
| `invoiceCogsReversal.test.ts` (T-D) | Dual-JE invoice (revenue + COGS) reverses cleanly |
| `payrollReverseCanonical.test.ts` (T-E) | D-14 regression: payroll JE actually flips to `'reversed'` |
| `voidRpcContract.test.ts` (T-F) | RPC argument names are part of the contract |

Tests require `SUPABASE_SERVICE_ROLE_KEY` and `TEST_ORG_ID` env vars;
they SKIP cleanly otherwise. Heavy fixtures (POS shift, payroll run)
also need `TEST_POS_SHIFT_ID` / `TEST_PAYROLL_RUN_ID`.

---

## 8. Things that are CORRECT and must not be "consolidated"

- The two atomic RPCs. Both are fine. Do not merge them.
- The split between line trigger and status trigger. Do not collapse them.
- The client-side fast-path `SELECT` in `useGLPosting` (defect D-15
  noted but acceptable) — it's a UX optimization, the unique index is
  still the guarantee.
- `accounts.current_balance` being trigger-owned. No app code should
  ever write it directly.

## 9. Open hardening items (deferred)

- **D-15** (low): `useGLPosting` client-side idempotency check creates
  a TOCTOU window. Harmless because the RPC + unique index still win,
  but reads like a guarantee when it isn't.
- **D-17** (doc): `post-payroll-gl` does not pass `_source_subtype`.
  Fine while there's one JE per payroll run; if employer-contribution
  accruals ever split into a second JE, they MUST carry an explicit
  subtype like `'employer_contrib'`.

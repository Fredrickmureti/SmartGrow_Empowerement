# Assistant Financial Answers: Ground Every Number in the Ledger

## What is actually wrong (verified against the live database this turn)

The assistant is not hallucinating prose — it is faithfully reporting a snapshot that is
built from broken and truncated queries. Three concrete defects produce exactly the wrong
numbers you saw.

### 1. "Bank Balance KES 0.00" — the bank query fails outright

`supabase/functions/ai-assistant/index.ts` selects
`id, name, bank_name, current_balance, currency, is_primary` from `bank_accounts`.

**`bank_accounts` has no `current_balance` column.** (Verified: the table has
`opening_balance`, `bank_reported_balance`, `bank_balance_as_of` — no `current_balance`.)
The whole select errors, the code does `bankResult.data || []`, and the error is silently
swallowed into an empty array. So `totalBankBalance` is 0, the "Bank Accounts" section
disappears, and the assistant reports KES 0.00 as if it were a fact.

Real cash position: opening balances plus the 4 recorded bank transactions =
**KES 96,420.40**, and the sanctioned way to obtain it is the
`bank_account_positions(business_id, as_of)` projection (ADR-0141), not a column read.

### 2. "Liabilities KES -5,250.00" — the chart of accounts is cut off at 50 rows

The accounts snapshot is `.order("code").limit(50)` over **154 active accounts**, with no
business filter. Summing only the first 50 by code gives liabilities **-5,250.00** — the
exact figure the assistant printed. The full active set is **-5,010.00**. Assets happened
to match (95,840.00) only because the asset accounts sort early. Equity, income and expense
were absent from the answer for the same reason.

### 3. The balances are denormalised columns, not the ledger

`accounts.current_balance` is a cached column. The rest of the platform derives financial
truth from posted journal entries (`get_account_movements`, as `src/services/gl/fetchGLTotals.ts`
does). Today the two happen to agree; nothing guarantees they keep agreeing, and the
assistant must never be the surface that quotes the stale one.

Receivables and payables have the same shape of problem: AR is summed from a 50-row invoice
slice and AP from a bills status list, instead of the sanctioned `finance_ar_open_items`
projection (`finance_ap_open_items` does not exist in this database — the AP side needs the
subledger query, not a status filter).

## The fix

### A. Silent failure becomes impossible (the systemic root cause)

Every snapshot query result gets checked. When a query errors, the prompt must say
`unavailable — query failed` for that section and the assistant is instructed it may not
state a figure for it. **A failed query may never render as 0.00.** This alone would have
prevented the wrong bank balance from ever being spoken.

### B. Financial figures come from the sanctioned sources

| Figure | Today | After |
| --- | --- | --- |
| Bank balances | `bank_accounts.current_balance` (does not exist) | `bank_account_positions(business_id, as_of)` — per account, in the account's own currency, plus base total |
| Account balances by type | first 50 `accounts.current_balance` | `get_account_movements` over the posted ledger, all accounts, business-scoped, signed by account type |
| Revenue / expenses | 30-day payment and expense rows | the same GL movements seam `fetchGLTotals` uses |
| Receivables | 50-row invoice slice | `finance_ar_open_items` residual |
| Payables | bills status filter | AP subledger residual (bills net of payment allocations and vendor credit notes) |

No truncation on aggregates: totals are computed by aggregate query, never by summing a
capped page. Where a list is capped for prompt size, the prompt says so explicitly
("showing 20 of 154") so the model cannot present a page as a total.

### C. Reconciliation context gets real banking depth

When the assistant is invoked from the reconciliation surface, its snapshot includes the
selected bank account's position, statement vs GL difference, unmatched line count, oldest
unreconciled date and the last reconciliation — read through the existing reconciliation
seams, still under the caller's RLS. Nothing about it can write or post.

### D. Ratchets so it cannot silently rot again

Architecture tests asserting: the assistant selects no column that does not exist in the
live schema for the tables it reads; no financial aggregate is computed from a `.limit()`ed
result; no snapshot query result is consumed without an error check; bank figures come from
the positions projection and account balances from the GL movements seam.

## Technical notes

- Files: `supabase/functions/ai-assistant/index.ts` (snapshot builders, prompt sections),
  a new `supabase/functions/_shared/financialSnapshot.ts` for the sanctioned reads, and a
  new `src/test/architecture/ai-assistant-financial-truth.test.ts`.
- All reads stay on the caller's JWT — RLS unchanged, no service-role widening, no new
  write seam.
- No database migration is required: every source this plan switches to already exists
  (`bank_account_positions`, `get_account_movements`, `finance_ar_open_items`).

## Sequencing

1. Error-checked snapshot + "unavailable" rendering (kills the fake zeros).
2. Bank positions and GL-derived account balances (fixes both wrong numbers).
3. AR/AP from the subledger projections.
4. Reconciliation-context banking depth.
5. Ratchet tests.

# AP Payment Failure — Root Cause and Settlement Convergence

## 1. Immediate root cause (verified, not inferred)

The database error behind the 400 is captured in the Postgres logs at the exact time of the attempt:

```
ERROR: Bank/cash account is required for multi-bill payment.
```

Chain of facts, each verified:

- `RecordBillPaymentDialog` only renders the bank-account selector when `bankAccounts.length > 0`, and seeds `bank_account_id` from `bankAccounts.find(a => a.is_primary)`.
- The `bank_accounts` table in this database contains **0 rows** (0 primary, 0 with a GL link). So the selector never renders and `formData.bank_account_id` stays `""`.
- The dialog sends `bank_account_id: formData.bank_account_id || null`.
- `useBills.recordMultiBillPayment` computes a valid GL cash account (`accounts.bank_account_id || accounts.cash_account_id`), validates it, **and then never sends it** — it forwards `args.bank_account_id ?? null`.
- `record_multi_bill_payment` line 1 of its body raises on a null `_bank_account_id`.

So the payment fails because the client dropped the only account it had resolved, and the treasury table it did consult is empty.

## 2. The deeper defect this exposes

`_bank_account_id` is used for **two incompatible things** inside one parameter:

- it is written to `bill_payments.bank_account_id`, whose FK is `REFERENCES bank_accounts(id)` — a **treasury instrument**;
- it is used as `account_id` on the credit line handed to `post_journal_entry_atomic` — a **GL account** in `accounts`.

These are different ID spaces. Had a bank account existed, the dialog would have sent a `bank_accounts.id` and the journal line would have referenced a non-existent GL account (or a mismatched one). The 400 is therefore masking a latent posting defect, not just a missing selection.

AR does not have this confusion: `payments.deposit_account_id` FKs to `accounts(id)` (GL) and `record_multi_invoice_payment` takes `_deposit_account_id` as a GL account, with the treasury link handled separately at reconciliation. **AP must be brought to the AR shape, not the other way round.**

## 3. Verified architecture status (what is already right)

- **Posting monopoly holds.** `record_multi_bill_payment` posts through `post_journal_entry_atomic`; no raw journal inserts (ADR 0123).
- **Allocation-first AP is real.** One `bill_payments` header + N `bill_payment_allocations`, single-vendor / single-currency / single-company guards, per-bill open-balance ceiling, sum-vs-total check, `FOR UPDATE` row locks (ADR 0028).
- **Reversal is server-side.** `void_bill_payment_atomic` is the single writer; client writes to `bills.amount_paid` and deletes on `bill_payments` are ratcheted (ADR 0126).
- **Reconciliation is correctly separate.** Payment recording does not touch bank statements; matching lives in the reconciliation engines.
- **Server-side idempotency exists** — `record_multi_bill_payment` replays on `client_request_id`.

Verdict on the engine itself: ⚠ needs a targeted fix, not a redesign. AR and AP are correctly *separate domain commands over shared infrastructure* (one posting engine, one allocation shape per direction). No duplicate payment engine was found.

## 4. Real defects to fix

1. ❌ **Account-space conflation** — one parameter serving both `bank_accounts.id` and `accounts.id`.
2. ❌ **Client can send no funding account at all**, and the hook silently discards the GL account it validated.
3. ⚠ **Idempotency not wired on the AP dialog** — `RecordBillPaymentDialog` passes no `requestId`, so a double-click or retry can record the payment twice. Server support exists; the client never uses it. The existing ratchet only bans `randomUUID()`; it does not require a key, so CI passes today.
4. ⚠ **Client-side accounting decisions** — the dialog derives open balance and allocation amounts from cached `bill.total - amount_paid`. Acceptable as *input pre-validation* (the server re-checks under lock), so this stays; no change.

## 5. Plan

### Step 1 — Split the two account concepts in the AP payment RPC
Migration adding an explicit GL parameter alongside the treasury one:
`record_multi_bill_payment(..., _bank_account_id uuid /* treasury, nullable */, _credit_account_id uuid /* GL, required */, ...)`.
- `_credit_account_id` is what the JE credits.
- `_bank_account_id` is stored on `bill_payments` only, and only when it references a real `bank_accounts` row.
- When `_credit_account_id` is null but `_bank_account_id` is given, resolve the GL account from `bank_accounts.account_id`; raise a clear error if that treasury row has no GL mapping.
- Keep the invariant that *some* funding account must resolve — do not weaken it.
- Old signature kept as a thin shim resolving the GL account the same way, so nothing else breaks.

### Step 2 — Make the hook send what it resolved
`useBills.recordMultiBillPayment` forwards its validated GL cash account as `_credit_account_id` and the (optional) treasury id as `_bank_account_id`. The "Cash or Bank account is not mapped" guard stays as the single client-side precondition.

### Step 3 — Wire idempotency on the AP dialog
Mint a request key from the payment intent when the dialog opens (vendor + allocation set + date + amount), pass it as `requestId`, and disable submit while in flight. Never `crypto.randomUUID()` per render.

### Step 4 — Make the funding account selectable even with no treasury rows
When `bank_accounts` is empty, the dialog shows the mapped default cash/bank GL account as the funding source (read-only line) instead of hiding the control, so the user always sees where the money leaves from.

### Step 5 — Tighten the ratchets
- Extend `money-movement-request-key.test.ts`: every client caller of a settlement RPC must pass a request key, not merely avoid `randomUUID()`.
- New architecture assertion: no client may pass a `bank_accounts` id into a parameter used as a GL account.
- ADR `0129-ap-funding-account-split.md` recording the treasury-vs-GL boundary and AR/AP ownership map.

### Step 6 — Verify
Re-run the KES 7,000 payment end to end: bill → payment → allocation → `bills.amount_paid`/status → balanced JE (Dr AP / Cr Bank) → unreconciled bank movement. Plus `tsgo --noEmit` and the architecture ratchets.

## Ownership map (unchanged by this work, recorded for clarity)

| Concern | Owner |
| --- | --- |
| Payment identity, method, date, currency | `bill_payments` / `payments` headers |
| AP allocation | `bill_payment_allocations` via `record_multi_bill_payment` |
| AR allocation | `payment_allocations` via `record_multi_invoice_payment` |
| GL posting | `post_journal_entry_atomic` (sole writer) |
| Cash/bank instrument | `bank_accounts` (treasury), linked to a GL account |
| Reconciliation | bank reconciliation engine, strictly downstream of payment |
| Reversal | `void_bill_payment_atomic` / `void_payment_atomic` |
| Idempotency | `client_request_id` on the settlement header |

## Not doing
- Not relaxing any invariant in the RPC to force a 200.
- Not merging reconciliation into payment recording.
- Not unifying AR and AP into one RPC — the separation is correct.

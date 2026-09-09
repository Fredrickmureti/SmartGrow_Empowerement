# Investigation: Daily Transaction Day Close / Open

Read-only investigation. No code or database changes were made.

## 1. Executive Verdict

**C — Not supported** (as an operational day). There is no concept of a business/operational/transaction day anywhere in the system: no table, no status, no open-day or close-day function, no branch day, no business date. Nothing in the backend governs *when* a payment may be recorded or *which day* it belongs to.

What does exist, and is genuinely useful, is a **per-group collection round** (a batch tied to a meeting) that can be closed and then banked, plus a **monthly accounting period** that can be locked. Neither is a daily branch close. So if you want to be precise with the client: the system can close *a collection round* and can close *a month*; it cannot close *Wednesday*.

## 2. What the Client Means

"Close Wednesday, open Thursday" implies, in system terms:
- a per-branch day record with a status (open/closed) and an owner,
- every money transaction stamped with that day and refused when the day is closed,
- a balancing step at close: expected collections vs. actual cash/bank vs. ledger, with a variance,
- an explicit next-day open carrying forward the closing cash/bank position,
- a controlled exception path for late entries and corrections.

None of those five things exists today.

## 3. What Already Exists

| Mechanism | What it does | Scope | Authority | Limits |
|---|---|---|---|---|
| `mf_repayment_batches` (`collected_on` date, `status` open/closed, `meeting_id`, `branch_id`) | Groups the receipts collected in one group meeting | One group / one meeting | Opened and closed by direct table insert/update from the UI (`useMfRepayments.openBatch`/`closeBatch`), not an RPC | Not a day. Several batches per day per branch; a payment can be recorded with **no batch at all** |
| `mf_guard_batch_closure` trigger (on `mf_repayments` and `mf_repayment_batches`) | Refuses to attach a repayment to a closed batch; refuses to reopen a closed batch | Batch | DB trigger, unbypassable from the app | Only bites when `batch_id` is supplied. `batch_id` is nullable |
| `mf_group_meetings` (`opened_at`, `closed_at`, `status`) + `mf_open_group_meeting` / `mf_complete_group_meeting` | The one real open→close lifecycle in lending. Completing a meeting force-closes its open batches | One group meeting | `mf_can_scoped(...,'clients','write')`; force-close of batches needs `repayments write` | Meeting-scoped, not branch-scoped. No financial balancing at close |
| `mf_collection_bankings` + `mf_bank_collection_batch(...)` | Banks a **closed** batch into a bank account, posts the journal entry, links `bank_transaction_id`/`journal_entry_id`; append-only; refuses to bank twice | One batch | SECURITY DEFINER RPC | Per batch, not per branch-day. No expected-vs-actual variance; the banked amount is derived from the posted receipts, so it cannot disagree with itself |
| `fiscal_periods` + `close_fiscal_period` / `reopen_fiscal_period` | Locks a date range against posting | Organization + business (`business_id NOT NULL`); `trg_fiscal_periods_no_branch_context` explicitly **forbids** branch-level periods | `finance.manage_periods`; blocked by `_fp_assert_balanced_before_close` (trial balance) and by unrevalued FX | Live data: 13 periods, all `period_type` month or year, **none closed**. Nothing prevents creating a 1-day period, but nothing creates one either |
| `enforce_fiscal_period_lock` trigger on `journal_entry_lines` | Raises "Cannot post to closed fiscal period" for any line whose entry date falls in a closed period | Org + business | DB trigger | The real enforcement. Date-range based, so day-level only if a 1-day period existed |
| `bank_reconciliation_sessions` | Reconcile one bank account against one `statement_date` | Bank account / business / branch | Finance permissions | Zero rows exist. Statement-driven, not a branch end-of-day |

## 4. Actual Group Sheet Payment Lifecycle

```text
GroupSheetDialog.tsx
  collectedOn  <- editable <input type="date">, defaults to today, NO min/max
  openBatch()  -> INSERT mf_repayment_batches (collected_on, group_id, meeting_id, branch_id, status='open')
  for each member line:
      supabase.rpc('mf_record_repayment', { p_loan_id, p_paid_on: collectedOn, p_amount,
                                            p_method, p_reference, p_batch_id, p_notes })

mf_record_repayment (SECURITY DEFINER)
  v_paid_on := COALESCE(p_paid_on, CURRENT_DATE)     <- caller's date wins; no bounds check
  permission: user_has_business_access(auth.uid(), business_id)
  duplicate guard: same non-empty `reference` on the same loan, not reversed  -> rejected
  INSERT mf_repayments (paid_on = v_paid_on, receipt RCP-YYYYMM-nnnnn from v_paid_on)
  allocate across installments per mf_allocation_policy
  INSERT mf_loan_events('repayment_recorded')
  PERFORM mf_post_event(event_id)      <- synchronous GL posting, same transaction
        -> journal_entries.entry_date  <- derived from the event / paid_on
        -> journal_entry_lines         <- trg_enforce_fiscal_period_lock fires here

Later, optionally:
  closeBatch()  -> UPDATE mf_repayment_batches SET status='closed'   (cannot be reopened)
  mf_bank_collection_batch(batch_id, bank_account_id, banked_on)
        -> mf_collection_bankings + journal entry + bank transaction
```

Answers to the specific questions:
- **Backdate?** Yes, freely. No client or server bound.
- **Future date?** Yes. `mf_open_group_meeting` rejects a future meeting date; `mf_record_repayment` has no equivalent check, so a future-dated receipt is accepted.
- **Who decides the date?** The UI. The server only fills in `CURRENT_DATE` when the client sends null.
- **Separate posting date?** No. One date (`paid_on`) flows through to the journal entry. There is no posting date, no value date, no effective date on this path.
- **Duplicate protection?** Only the per-loan `reference` uniqueness. Two cash receipts with a blank reference for the same client, same amount, same day are both accepted.
- **Immediate or batched posting?** Immediate. The ledger is hit inside the same transaction; the batch is a grouping/banking device, not a posting stage.
- **M-Pesa path** (`supabase/functions/mpesa-c2b`) calls the same RPC with the date taken from the M-Pesa transaction timestamp.

## 5. Daily Close Behaviour

Wednesday cannot be closed. The only closes available on Wednesday are: close each group's collection batch, complete each meeting, bank each closed batch. Doing all three for every group leaves the branch with **no** record that says "Wednesday is finished", and does not stop a fourth batch being opened for Wednesday five minutes later, or an unbatched receipt dated Wednesday being recorded next month.

## 6. Next-Day Open Behaviour

Thursday cannot be opened, because nothing is opened. Thursday exists only as a calendar value that happens to be the default in a date field. No opening balance, no beginning cash, no beginning bank position, no day record, no branch status change.

## 7. Late Entries (Wednesday's cash keyed on Thursday)

The officer types Wednesday into the date field and the system accepts it silently. The receipt is dated Wednesday, the journal entry is dated Wednesday, the receipt number is `RCP-YYYYMM-…` derived from Wednesday. No authorisation, no late-entry flag, no audit event distinguishing it from an on-time entry. The only trace is `created_at` (Thursday) differing from `paid_on` (Wednesday) — a difference nothing currently reports on. Live data: 0 repayments exist, so there is no production evidence either way.

Corrections use `mf_reverse_repayment(p_repayment_id, p_reason)` — reverse and re-record. `mf_repayments` and `mf_collection_bankings` are effectively append-only; there is no edit path.

## 8. What Happens After "Close"

- After a **batch** closes: new payments cannot be attached to that batch (trigger). Payments with a null or different `batch_id`, for the same group and the same date, still post.
- After a **meeting** completes: its open batches are force-closed. A new meeting can be opened for the same group on the same date only subject to that RPC's own rules; repayments outside a meeting are unaffected.
- After a **fiscal period** closes: every posting whose entry date falls in the range is refused at `journal_entry_lines`, which rolls back the whole `mf_record_repayment` call. That is a real, month-wide lock — it would stop Wednesday, but only by stopping the entire month.
- Reversals of an entry inside a closed period are equally blocked, because the reversing entry is itself a posting.

One defect worth recording: `close_fiscal_period` sets `status='closed'` but never sets the `is_closed` boolean column, while the helper `is_period_open(business_id, date)` tests `COALESCE(is_closed, false)`. So `is_period_open` would report a closed period as **open**. Fourteen functions call it. Actual protection comes from the `enforce_fiscal_period_lock` triggers, which test `status`. Untestable against data today (no period is closed), but the divergence is visible in the function bodies.

## 9. Accounting Period vs Operational Day

These are not the same and the code does not conflate them. A fiscal period is a month (or the year) owned by a business, closed by a finance role, guarded by a trial-balance assertion, and enforced through journal lines. An operational day would be a branch-owned, daily, cash-facing control. The system has the first and not the second. Because the schema allows any date range, someone could create a one-day fiscal period as a workaround — but it would be business-wide, not branch-wide, would require finance permissions, would demand a balanced trial balance every single day, and would block every other module in the business for that date.

## 10. Branch / Multi-Tenant Scope

- Fiscal periods: organization + business. Branch-level periods are actively prevented by `trg_fiscal_periods_no_branch_context`. **Branch A cannot close Wednesday while Branch B keeps trading.**
- Batches, meetings, bankings, repayments: all carry `branch_id`, so they are branch-attributable — but attribution is not control.
- Visibility is role-scoped (`mf_is_portfolio_restricted`, `mf_officer_in_scope`, `user_branch_scope`), so a loan officer sees their own portfolio. That governs *who sees what*, not *when things may be recorded*.

## 11. Evidence

- `mf_record_repayment` body: `v_paid_on date := COALESCE(p_paid_on, CURRENT_DATE)`; no date validation; `PERFORM mf_post_event(v_event_id)`.
- `mf_guard_batch_closure`: "A closed collection batch cannot be reopened" / "This collection batch is closed; open a new batch to record the payment".
- `mf_complete_group_meeting`: force-closes `mf_repayment_batches WHERE meeting_id = … AND status <> 'closed'`.
- `mf_bank_collection_batch`: "Batch % must be closed before it can be banked", "Batch % has already been banked".
- `mf_open_group_meeting`: "A meeting cannot be recorded for a future date" — the only future-date guard found in lending.
- Triggers on `journal_entry_lines`: `trg_enforce_fiscal_period_lock`, `trg_fiscal_period_lock` → `enforce_fiscal_period_lock` (tests `fp.status = 'closed'`).
- Triggers on `mf_repayments`: batch guard, numbering, SoD guard, settled-loan guard — **no** period or date guard.
- `fiscal_periods.business_id NOT NULL`; `trg_fiscal_periods_no_branch_context`.
- Name sweep across `src/` and `supabase/`: `posting_date`, `value_date`, `day_status`, "operational day", "cashbook", "branch close", "daily close", "daily reconciliation" — **no hits**. `business_date` appears only on the accounting-events queue and FX/M-Pesa reconciliation tables, none of them `mf_*`. "End of Day" appears once, in a POS Z-report view.
- UI: `RecordPaymentDialog.tsx:125` and `GroupSheetDialog.tsx:204` are plain date inputs with no `min`/`max`. `RecordMeetingDialog.tsx:132` does set `max={todayIso()}`.
- Live data: `mf_repayments` 0, `mf_repayment_batches` 0, `mf_collection_bankings` 0, `mf_group_meetings` 1, `bank_reconciliation_sessions` 0, `fiscal_periods` 13 (12 monthly + 1 yearly, all open). No day/session/close records of any kind exist.

## 12. Client-Facing Explanation

Today the system records each payment against whatever collection date the officer enters, and posts it to the accounts straight away under that same date. It can group a meeting's collections into a collection round, close that round so nothing more can be added to it, and record the round being banked. It can also lock a whole accounting month once the books balance, after which nothing can be posted into that month.

What it does not have is a working day that a branch opens in the morning and closes in the evening. There is no record that says "Wednesday is closed at this branch", no end-of-day balancing of expected collections against cash and bank with a variance to sign off, and no carry-forward of Wednesday's closing position into Thursday. Because of that, a payment dated Wednesday can still be entered on Thursday, or next week, without any approval or flag — the system will simply accept the date it is given. Branches also cannot close their day independently: the only lock available covers the whole business for a whole month.

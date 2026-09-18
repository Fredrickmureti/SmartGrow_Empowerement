# Bank balance vs bank report: the 37,000 difference — verdict and fix

## What is actually happening

The two screens count reversed entries differently. Both numbers come from the same rows; one of them counts half of a reversal.

When an entry is reversed, the system does not delete it. It marks the original as "reversed" and posts an opposite entry. Both must be counted together so they cancel out.

- The bank report counts the original and its reversal. Correct.
- The chart of accounts balance counts only entries marked "posted", which skips the reversed original but still counts the reversal. That leaves one lonely 37,000 line, so the balance comes out 37,000 too high.

## The 37,000 in question (verified in the data)

| Entry | Date | Bank effect | State |
|---|---|---|---|
| JE-00041 Fixed asset acquisition: Core Banking System | 17 Sep | out 37,000 | reversed |
| JE-00042 Reversal of JE-00041 "Posted wrongly" | 17 Sep | in 37,000 | posted |
| JE-00067 Fixed asset acquisition: Core Banking System (corrected) | 18 Sep | out 37,000 | posted |

Net real effect on the bank: 37,000 out, once. The report's 561,878.95 reflects that. The chart of accounts figure of 598,878.95 silently drops JE-00041's outgoing 37,000.

## Verdict

- The report is right. The bank book balance is **KSh 561,878.95**.
- The chart of accounts figure of 598,878.95 is overstated by exactly the reversed amount. It is a display/calculation defect, not missing entries.
- Nothing is lost or corrupted in the ledger. Every line is present and every entry is balanced.
- One business question for you: if your real bank statement genuinely reads 598,878.95, then the 37,000 asset payment has not actually left the bank yet, and the corrected entry JE-00067 is dated ahead of the real payment. That is a data question, separate from this defect.

## Same defect elsewhere (all accounts touched by a reversal)

| Account | Chart of accounts shows | Correct balance | Overstated / understated by |
|---|---|---|---|
| 1111 Petty Cash | 11,369.00 | 119.00 | +11,250 |
| 1112 Bank - Main Account | 598,878.95 | 561,878.95 | +37,000 |
| 1214 Computer Equipment | 35,000.00 | 72,000.00 | −37,000 |
| 1370 Loan Principal Receivable | 55,000.00 | 70,000.00 | −15,000 |
| 2440 Unearned Loan Interest | −11,000.00 | −14,000.00 | −3,000 |
| 4320 Loan Fee Income | −9,750.00 | −10,500.00 | −750 |

This also explains the earlier ledger-versus-portfolio mismatch on loan receivable: same root cause, not a lending bug.

## Fix (one change, no data edits)

Make the balance calculation use the same entry states as the ledger and the reports.

1. `get_account_balances` — replace `je.status = 'posted'` with `je.status = ANY (public.ledger_visible_journal_statuses())`, which is the shared definition already used by `get_general_ledger` (`posted` + `reversed`).
2. `get_account_balance_at_date` — same replacement.
3. Sweep the remaining balance readers for a hard-coded `status = 'posted'` filter over journal lines (trial balance, account register, dashboard cash tiles) and route them through the same helper, so one definition governs every balance on screen.
4. Grant execute on `ledger_visible_journal_statuses` so it is callable from the same roles that read balances.
5. Add a regression test asserting that for every account, the chart-of-accounts balance equals the general-ledger closing balance — the check that would have caught this on day one.

No journal entries are created, edited or deleted. The balances simply start including both halves of each reversal.

## After the fix

Re-run the bank report and the chart of accounts and confirm both read 561,878.95, and that the six accounts above agree with their ledger closing balances.

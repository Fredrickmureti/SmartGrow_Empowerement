# Branch Day Difference of KES 11,250 — Investigation Report (no changes made)

## 1. Executive finding

The KES 11,250 is **not** cash, not a shortage, and not a real movement. It is a
**software defect in the expected-cash calculation**: a reversed loan
disbursement is counted once instead of cancelled out.

On 16 Sep the disbursement of loan **LN-000007** paid out cash of 12,000 and took
a 750 fee back in cash — net cash out **11,250** (JE-00029). That entry was later
reversed (JE-00033, the mirror image, +11,250) and the loan was re-disbursed
through the bank instead (JE-00034, no cash).

The ledger records a reversal by **keeping the original entry and adding a
mirror**, marking the original `reversed`. The canonical ledger helper
`ledger_visible_journal_statuses()` therefore returns `['posted','reversed']`.
`branch_day_expected_cash` ignores that helper and filters `je.status = 'posted'`
only — so the original (−11,250) drops out and the mirror (+11,250) stays.

Net cash movement in the box for 16 Sep is **zero**. Expected cash should read
**171,974.00**, the same as the opening figure.

## 2. The displayed numbers

| Tile | Source | Value |
| --- | --- | --- |
| Cash at open | `branch_operational_days.opening_cash`, day `a72fe91d…` | 171,974.00 |
| Cash the books expect now | RPC `branch_day_expected_cash(day_id)` | 183,224.00 |
| The 11,250 | Not a stored field — the operator's own subtraction of the two tiles | 11,250.00 |

The system does **not** display a "difference" on the open day. The real
variance (counted − expected) exists only once cash is physically counted in the
close dialog. No counted figure exists yet for 16 Sep.

`branch_day_expected_cash` = `opening_cash + Σ(debit − credit)` on the single
account mapped to `cash` (**1111 Petty Cash**), for that branch, where
`entry_date = business_date` **and `status = 'posted'`**. It is computed live
from the ledger — not cached, not a snapshot, so it is not stale.

## 3. Transaction-by-transaction reconciliation (HQ, 1111 Petty Cash, 16 Sep)

| Entry | Created | Status | Net to cash | In calc? |
| --- | --- | --- | --- | --- |
| JE-00029 disbursement LN-000007 (Cr 12,000 / Dr 750 fee) | 17 Sep 05:25 | reversed | −11,250 | **No** |
| JE-00033 reversal of JE-00029 | 17 Sep 07:15 | posted | +11,250 | Yes |

```text
171,974.00 opening
+  11,250.00 mirror reversal counted
-        0.00 original never deducted   <- the defect
= 183,224.00 displayed
True position: 171,974.00 + 0 = 171,974.00
```

Nothing else touched cash on 16 Sep. The other entries dated 16 Sep (JE-00025,
26, 27, 28, 30, 31, 32, 34) settle through **1112 Bank – Main Account** or are
reclassification journals, so they correctly do not move the cash box. The
remainder is **0.00 — fully reconciled.**

## 4. Business-day lifecycle and authoritative records

- `branch_operational_days` — id, branch_id, business_date, status, opening_cash,
  expected_cash, counted_cash, variance, variance_reason,
  variance_journal_entry_id, opened_by/at, closed_by/at, reopened_count.
- `branch_day_events` — append-only history (open / close / reopen, actor, reason).
- One open day per branch is enforced by a **partial unique index** on
  `(branch_id) WHERE status = 'open'`, not by screen logic.
- `open_branch_day` / `close_branch_day` / `reopen_branch_day` are the only
  writers; both roles `anon` and `authenticated` hold no write grant on the tables.
- Close blocks on open collection rounds, requires a reason for any variance, and
  posts the over/short to **6910 Cash Over/Short**.
- HQ register: 10 Sep closed (0 variance), 11 Sep closed, 15 Sep closed, 16 Sep open.

## 5. Could 17 Sep activity land in 16 Sep? Yes — and it did

`enforce_branch_day_lock` on `journal_entries` checks only that a day row exists
for `entry_date` **and is open**. It never compares `entry_date` to the server's
today. The screens (`BranchDayDateField`) date every money entry with the **open
day's** date. So while 16 Sep stays open, all work is dated 16 Sep.

Evidence: JE-00029 through JE-00034 were all created on **17 Sep** and carry
`entry_date = 2026-09-16`. This is the designed behaviour of day control
(category B — accepted and assigned to the open business day), not a breach. It
is also exactly what the on-screen warning describes.

Path coverage: loan disbursements, repayments, client fee receipts, collection
rounds and reversals all post through `post_journal_entry_atomic`, the single
ledger writer carrying the guard, so all are governed identically. Collection
rounds carry a second guard (`trg_enforce_batch_branch_day`). Kitengela branch
has no go-live date set, so it is not under day control at all.

## 6. Scope of the figures

Opening cash and expected cash use the **same** scope: the one account mapped to
`cash` for this business (1111 Petty Cash, an unbranched mapping), filtered to
`branch_id = Headquarters`. Bank, mobile money and other branches are excluded.
No till-level split exists. No cash line on 16 Sep had a missing branch.

## 7. Duplicate / misclassified findings

The mirror reversal JE-00033 is **included while its original is excluded** —
effectively counted once rather than netted to zero. No duplicated, missing or
misbranched movements otherwise.

## 8. Wider impact of the same defect

`branch_day_expected_cash` is the only object found using the bare
`status = 'posted'` filter on this path. General ledger, trial balance, journal
report, opening balances and budget variance all use
`ledger_visible_journal_statuses()` and are therefore correct. Note one legacy
2-argument overload of `get_account_movements` still filters `'posted'` only and
carries the same risk — worth confirming which callers use it.

## 9. Root cause (confirmed)

`public.branch_day_expected_cash` filters `je.status = 'posted'` instead of
`je.status = ANY (public.ledger_visible_journal_statuses())`. Any branch day
containing a reversal will show expected cash wrong by the reversed amount —
overstated for a reversed payment out, understated for a reversed receipt.

## 10. Recommended next steps

**Safe operational action now**
- Do **not** close 16 Sep against 183,224. The books genuinely expect
  **171,974.00**.
- If the physical count is 171,974, there is no shortage. Closing against the
  current screen would force an 11,250 "short" and post a false Cash Over/Short
  journal.
- Once the day is verified, close 16 Sep promptly so 17 Sep activity stops
  landing in it.

**Code correction (needs your approval — nothing changed yet)**
1. Align `branch_day_expected_cash` to `ledger_visible_journal_statuses()`, so
   reversals net to zero. This is a read-only calculation: no stored balance, no
   historical record and no journal entry is altered by the fix.
2. Review the legacy 2-argument `get_account_movements` overload for the same
   filter.
3. Consider showing "movement since open" and the reversal on the day screen so
   an operator can see what makes up the change.

**Further evidence useful**
- The physical count for 16 Sep, to confirm the box holds 171,974.
- Confirmation that LN-000007's cash payout was genuinely cancelled and reissued
  by bank (JE-00034), which the ledger indicates.

## 11. Regression test matrix

| # | Scenario | Expectation |
| --- | --- | --- |
| 1 | Open day, no activity | expected = opening |
| 2 | Cash payment out, not reversed | expected = opening − amount |
| 3 | Cash payment out then reversed same day | expected = opening (the 11,250 case) |
| 4 | Cash receipt then reversed | expected = opening |
| 5 | Reversal dated a later open day | each day reflects its own side |
| 6 | Bank/mobile disbursement | expected unchanged |
| 7 | Another branch's cash movement | excluded |
| 8 | Close with count = expected | zero variance, no over/short journal |
| 9 | Entry dated a closed day | refused by the ledger guard |
| 10 | Entry created on a later calendar date while a day is open | accepted, dated to the open day |

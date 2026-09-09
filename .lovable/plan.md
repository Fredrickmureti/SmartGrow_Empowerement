# Remediation Plan: Branch Operational Day (Open / Close)

## Executive Verdict

**The gap is real and it is a control gap, not a reporting gap.** The system today can close a group's collection round and can lock a whole accounting month; it cannot close Wednesday at Kitengela while Headquarters keeps trading. Any date an officer types is accepted, backdated or future-dated, with no approval trail and no end-of-day balancing.

The remediation is smaller than it looks, because the investigation confirmed one decisive fact: **every financial effect in this system reaches the ledger through a single writer.** `post_journal_entry_atomic` is the only function in the database that inserts into `journal_entries`, it always receives a `branch_id` and an `entry_date`, and all 6 existing entries carry a branch. Loan disbursement, repayment, fee collection, charge payment, write-off, reversal and collection banking all funnel through it via `mf_post_event`.

So the operational day does **not** need a new ledger, a new reconciliation engine, or changes to lending, KYC, meetings, fiscal periods or bank reconciliation. It needs one branch-owned day record, one guard at the existing choke point, and an open/close workflow around it.

## Architecture Findings That Shape the Design

| Finding | Consequence for the design |
|---|---|
| `post_journal_entry_atomic` is the sole GL writer; `journal_entries` carries `branch_id` + `entry_date` | The day lock is one trigger, at the same place the fiscal-period lock already lives. Nothing can slip past it. |
| `mf_post_event` posts synchronously inside the recording transaction | Blocking the posting blocks the operation. No async queue to police. |
| `fiscal_periods.business_id NOT NULL` + `trg_fiscal_periods_no_branch_context` | A fiscal period can never be the operational day. The two must stay separate objects with separate authority. |
| `mf_repayment_batches` / `mf_group_meetings` are per-group, `batch_id` is nullable | Batches and meetings cannot be promoted into the day. The day sits above them and does not replace them. |
| Branch permissions already exist: `mf_can_scoped` → `user_has_module_permission_in_branch`, modules include `treasury`, `collections`, `repayments`, `branches` | Reuse. No new permission engine. |
| Live data: 2 branches (1 inactive), 0 repayments, 0 batches, 6 journal entries | Bootstrap is trivially clean. We can enable day control from a chosen go-live date with no back-fill. |
| Defect found: `close_fiscal_period` sets `status` but not `is_closed`, while `is_period_open()` reads `is_closed` | Fix in the same wave — the new day code must not inherit that pattern. Day status will be a single column, read the same way everywhere. |

## The Business Event Model

Three new authoritative events, each recorded once, each attributable:

1. **Day opened** — a named user declares a branch open for a calendar date and states the opening cash-on-hand position.
2. **Day closed** — the same or another authorised user declares collections finished, counts cash, and accepts or explains a variance.
3. **Day reopened** — an exception, higher authority, mandatory reason, always visible in the audit trail.

Everything else (receipts, disbursements, fee collections, bankings) stays exactly as it is today and simply gains a day stamp.

## Lifecycle

```text
  (no day)  --open-->  OPEN  --close-->  CLOSED
                        ^                   |
                        +----- reopen ------+   (privileged, reasoned, audited)
```

- One day row per branch per calendar date. Enforced by a unique constraint, not by application code.
- A branch may have at most one OPEN day at a time. Opening Thursday while Wednesday is still open is refused, with a message naming Wednesday.
- Opening a date earlier than the branch's last closed day is refused.
- Future dates are refused outright.

## Scope and Dating Rules

- The day is **branch-owned** (`branch_id`, plus `business_id` and `organization_id` for scope), never business-wide. Branch A closing does not affect Branch B.
- The transaction date an operator may enter is bounded by the branch's open day. The date input stops being free text: it is pre-filled with the open day's date and is not editable while day control is on.
- Postings dated a **closed** day are refused at the ledger with a clear message. Postings dated a day that was never opened are refused once day control is active for that branch.
- **Late entries** (Wednesday's cash keyed on Thursday) are handled by exception, not silently: either an authorised reopen of Wednesday, or the receipt is recorded in Thursday's open day and carries an explicit `occurred_on` note. There is no third, quiet path.
- **Corrections** keep the existing model: `mf_reverse_repayment` and siblings. The reversal is itself a posting, so it obeys the same day rules.

## Balancing at Close

At close the system computes, from the ledger only (no second source of truth):

- expected cash on hand = opening cash + cash-in movements − cash-out movements on the branch's cash accounts for that date, read from `journal_entry_lines`;
- actual cash counted = entered by the operator at close;
- variance = actual − expected.

A zero variance closes cleanly. A non-zero variance requires a reason and, above a configurable branch tolerance, a second authoriser. The variance is posted to a cash over/short account through the same `post_journal_entry_atomic` writer, dated that day, so the ledger and the day record can never disagree.

Bank movements are **not** balanced here. Banking a collection batch stays where it is (`mf_bank_collection_batch`), and bank reconciliation stays statement-driven. The day balances cash, which is what a branch can actually count.

## First-Day Bootstrap

Each branch gets an activation date. Before that date the branch behaves exactly as today; from it, day control is mandatory. The first day opens with an opening cash figure that the branch states and an authoriser confirms — zero for a branch with no loans yet, which is the current live situation for both branches. No historical days are fabricated.

## Security, Concurrency, Audit

- Open and close run as SECURITY DEFINER RPCs; the day table is not writable directly from the client. Permission via the existing `mf_can_scoped(business, branch, 'treasury', 'write')`; reopen requires a distinct manage-level operation.
- Concurrency: a per-branch advisory lock plus `SELECT … FOR UPDATE` on the day row inside every RPC, and a unique index on (branch, date) as the last line of defence. Two officers pressing Close simultaneously produce one close and one clear error.
- Audit: an append-only day-event log (opened / closed / reopened, actor, timestamp, figures, reason), enforced append-only by trigger like `mf_loan_events` already is, plus entries in the existing `audit_logs`.

## UI

- A branch day strip in the lending shell: today's date, status, who opened it, expected cash so far. Visible everywhere money is recorded.
- Open Day dialog: date (defaulted, bounded), opening cash, confirm.
- Close Day workspace: unbanked closed batches, open batches still un-closed (blockers), expected vs counted cash, variance and reason, confirm.
- Every money dialog stops offering a free date field once day control is on and shows the day it will post to.
- A branch day register listing past days with their figures and variances.

## Database Changes

Migrations stay small and single-purpose, one object each, in this order:

1. `branch_operational_days` table (+ grants, RLS, unique index).
2. `branch_day_events` append-only log (+ grants, RLS, trigger).
3. Branch activation column and tolerance setting.
4. `open_branch_day` RPC.
5. `close_branch_day` RPC (including the expected-cash computation).
6. `reopen_branch_day` RPC.
7. `enforce_branch_day_lock` trigger on `journal_entries`.
8. Secondary guards: refuse opening a collection batch dated a closed/unopened day.
9. Fix `close_fiscal_period` / `is_period_open` divergence.

## Migration Path

No back-fill and no data rewrite. Day control is off until a branch is activated, so the change is inert on delivery and becomes binding branch by branch on a date the institution chooses.

## Tests

Open/close/reopen happy paths; second open refused; posting into a closed day refused; posting into an unopened day refused after activation; branch isolation (A closed, B still posting); concurrent close; variance thresholds; reversal inside a closed day refused; behaviour unchanged for a branch before activation; fiscal-period lock and day lock both firing.

## Phases

- **Phase 1 — Record and lock.** Day table, event log, open/close RPCs, ledger trigger, tests. Delivers the control.
- **Phase 2 — Balancing.** Expected-vs-counted cash, variance posting, tolerance and second authoriser.
- **Phase 3 — Surface.** Day strip, open/close dialogs, bounded date fields, day register.
- **Phase 4 — Exceptions and reporting.** Reopen workflow, late-entry visibility, daily branch cash report.

## Non-Goals

Not a fiscal period and not a replacement for one. Not bank reconciliation. Not a second ledger or cash book. No change to loan, client, KYC, meeting, batch or banking logic beyond the day stamp and the date bound.

## Risks

- Bounding the date field removes flexibility officers currently rely on; the reopen path must be usable or it will be worked around.
- A forgotten close leaves a branch open indefinitely; needs a stale-day alert.
- Expected cash is only as good as the cash-account mapping per branch (`mf_resolve_account`); a mis-mapped branch produces a phantom variance.

## Unresolved Questions

1. Does a day close require a second person, or is the branch manager alone sufficient?
2. Variance tolerance: a fixed amount per branch, or a percentage of collections?
3. Must all collection batches be closed and banked before the day can close, or is unbanked cash a legitimate carry-forward?
4. Who may reopen a closed day — branch manager, or head office only?
5. What is the go-live date per branch for day control?


===============IMPLEMENTATION PROGRESS=================

Verified in the database (present and live):
- `branch_operational_days` and the append-only `branch_day_events` history.
- RPCs `open_branch_day`, `close_branch_day`, `reopen_branch_day`, `branch_day_expected_cash`.
- Guards: `trg_enforce_branch_day_lock` on `journal_entries`, `trg_enforce_batch_branch_day` on `mf_repayment_batches`, `trg_branch_day_events_append_only`.
- Accounting-month closed/open marker inconsistency fixed; existing months corrected.

Completed this session:
- Fixed the two component mismatches on the Branch day screen (status pill, error state).
- Added **Lending → Servicing → Branch day** to the menu and the `/lending/day` route (permission `recordRepayments`).
- Typecheck passes.

Still outstanding:
- Phase 3 remainder: bound the date field in the other money dialogs to the open day and show the day they post to.
- Phase 4: stale-day alert, daily branch cash report, late-entry visibility.
- Automated tests for the lifecycle, branch isolation and concurrency.
- Open business questions 1–5 above are still unanswered by the client.
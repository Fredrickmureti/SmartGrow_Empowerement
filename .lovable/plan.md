# Day Control Enablement — Root Cause and Remediation

## A. Root cause (verified)

`open_branch_day` refuses because the branch has never been activated:

```text
Branch day page  → openDay.mutateAsync
  → rpc open_branch_day(branch_id, ...)
    → reads public.branches (name, business_id, organization_id, day_control_from, is_active)
    → mf_can_scoped(business, branch, 'treasury', 'write')   [passes]
    → IF branches.day_control_from IS NULL
         RAISE 'Day control is not enabled for %'             ← P0001 raised here
```

Live data confirms it:

| branch | code | day_control_from |
| --- | --- | --- |
| Headquarters | HQ | null |
| Kitengela Branch (inactive) | KTG | null |

So enablement is a single column — `branches.day_control_from`, a **go-live date**
(null = branch not under day control; a date = day control applies from that date
onward). It is read by `open_branch_day`, by the ledger guard
`enforce_branch_day_lock`, by the collection-round guard
`enforce_batch_branch_day`, and in the UI by `useBranchDayGate`
(`BranchDayDateField`) and `BranchDayPage`.

Nothing anywhere writes it. Verified: no database function sets
`day_control_from`; no frontend file writes it; the two branch settings tabs
that exist (Settings → Company → branch → Settings → *Configuration* /
*Operations*) edit branch setting overrides and re-scope bank accounts and
payment methods respectively — neither touches day control.

## B. Verdict

**Partially implemented feature.** Column, RPC enforcement, posting guards, day
register UI and behavioural test scaffolding all exist. The *activation*
step — the administrator setting the go-live date — was never built, in any
layer: no RPC, no UI, no seed. The error message is therefore a correct
business rejection of an unreachable configuration state, which is why it reads
as a dead end to the operator.

Headquarters is a normal operational branch in this deployment (the only active
one, and the branch all current cash activity belongs to). It is eligible for
day control; it simply has not been activated. No classification change is
warranted.

## C. What will be built

### 1. Activation RPC (`set_branch_day_control`)

One `SECURITY DEFINER` function, matching the posture of the existing day RPCs
(advisory lock, permission via the existing `mf_can_scoped` framework, no
hard-coded roles):

- Authority: the branch-configuration capability the existing resolver already
  answers for the `settings` module (confirmed against
  `user_has_module_permission` before the SQL is written) — plus the existing
  `branches` UPDATE policy posture (owner/admin), so no new role concept.
- **Activation**: sets `day_control_from` to a date that is today or later only.
  Backdating is refused — activating retroactively would invalidate already
  posted entries that no day covers. Refused if already set to the same value.
- **Deactivation** (`null`): refused while a day is open at that branch; allowed
  otherwise, so a mis-set go-live can be corrected. Closed historical days are
  retained untouched.
- **Change of date**: allowed only while no operational day has yet been
  recorded for the branch; once days exist the date is fixed.
- Every activation, change and deactivation is written to the existing audit
  trail with actor, branch, old and new value, and reason.
- Also allows setting `day_variance_tolerance`, which is likewise read by
  `close_branch_day` and today has no editing surface.

### 2. Activation UI

A **Day control** card added to the existing branch settings dialog
(Settings → Company → *branch* → Settings), beside Configuration and
Operations. Shows current state ("not switched on" / "in force since <date>"),
a go-live date field defaulting to today, the cash variance tolerance, and a
plain-language explanation of what switching it on does to transaction dates.
Rendered read-only for users without the capability.

### 3. Actionable message on the Branch day page

When the selected branch has no go-live date, the page stops presenting *Open
the day* as if it would work: it shows an inline notice explaining that an
authorised administrator must switch day control on for this branch first, with
a link straight to that branch's settings. The backend rejection is left exactly
as it is.

## D. Production-safe testing

No production row is read-modify-written. Fixture work is confined to one
temporary branch (`ZZTEST-DAYCTL`) inside the existing business, created and
removed by the test itself; its id is captured and reported. Value-level
digests (`md5` over ordered `row_to_json`) are taken before and after over
`branches`, `branch_operational_days`, `branch_day_events`, `journal_entries`,
`journal_entry_lines`, `mf_clients`, `mf_groups`, `mf_group_meetings`,
`mf_loan_applications`, `mf_client_charge_payments` and `mf_fee_collections`,
excluding the fixture, and any drift fails the run. Headquarters' own
`day_control_from` is only changed through the new supported RPC, as the
deliberate go-live action, and only with your say-so.

Scenarios covered: activation refused without the capability; refused for a past
date; accepted for today; open day succeeds after activation; refused before the
go-live date; second open day refused; future date refused; concurrent opens
produce one day; zero-activity day opens and closes; deactivation refused while
a day is open.

## E. Resulting flow

```text
Settings → Company → <branch> → Settings → Day control
        ↓  (owner/admin capability)
Set go-live date (today or later) → saved + audited
        ↓
Lending → Branch day → select branch → Open the day
        ↓
Count opening cash, confirm → day opens, register row appears
        ↓
From then on money entries carry the open day's date; closed days refuse postings
```

## Out of scope

Loan, reconciliation, reporting and unrelated accounting work. Transaction-date
enforcement is only verified for consistency, not redesigned.


=============IMPLEMENTATION PROGRESS AND WHERE THINGS STAND================
I found and fixed the cause, but the last piece is unfinished.

What I found: opening the day failed because day control had never been switched on for Headquarters — there was no screen or action anywhere in the system to switch it on, so the branch could never be opened. The message you saw was correct, just unreachable to act on.

What is now in place:

A supported, audited action to switch day control on or off for a branch, with the safeguards: no back-dating, no switching off while a day is still open, permission required, and every change recorded with who and why.
A new "Day control" tab in Settings → Company → your branch → Settings, where an administrator sets the start date and the allowed cash difference at close.
What is unfinished: the Branch day page notice (telling staff to have an administrator switch day control on, instead of offering a button that will fail) was mid-edit, so that page may not build right now, and nothing has been tested end to end — no day has been opened, and the safety tests from the plan have not been run.

Credits ran out, so continuing needs available credits; once they are topped up I'll finish that page, verify it builds, and walk the open-day flow through
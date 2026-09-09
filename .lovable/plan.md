# Field / Group Meeting Lifecycle — Investigation Verdict and Remediation

## 1. Verdict

**The business event "a group meeting happened" is not recorded anywhere.** This is
a missing authoritative event, not a hidden or fragmented feature — and it is *not*
a missing "Close Day".

What exists today:

- A group carries a **recurring meeting rule**: `mf_groups.meeting_day` (smallint
  weekday), `meeting_time` (time), `meeting_place` (text), plus `loan_officer_id`
  and `branch_id`. The rule is captured and displayed on the Groups list
  (`GroupsPage.tsx` lines 195-197) but nothing consumes it: no "today's meetings"
  view, no due date derivation, no next-meeting calculation anywhere in code or SQL.
- A **collection batch** (`mf_repayment_batches`: group_id, collected_on,
  collected_by, status, batch_number) is the only per-meeting-ish record. It is
  money-only: it holds repayment receipts and nothing else. It is opened and closed
  by direct client-side inserts/updates from `useMfRepayments.ts` (batch number is
  generated in JavaScript), with one server guard, `mf_guard_batch_closure`, that
  prevents reopening a closed batch and blocks receipts into a closed one.
- `mf_collection_activities` exists (loan-level follow-up log: promise to pay,
  outcome, notes) with 0 rows. It is per-loan arrears follow-up, not a meeting.
- **Nothing else exists.** No table, view, RPC, trigger, hook, route or component
  for: meeting/session, attendance, field visit, operational day, branch or officer
  working day, meeting outcome, meeting completion, next-meeting scheduling,
  postponement, or follow-up items. Verified by full schema scan of `public` and a
  repository-wide search.

Consequences the owners are describing exactly match this gap: an officer can take
money at a meeting, but cannot record that the meeting occurred, who attended, what
was accomplished, what is pending, or when the group meets next. Today they write
the closing time on paper.

Production data checked before proposing anything: 1 group (with a meeting day set),
6 clients, 6 group members, 0 loans, 0 batches, 0 collection activities. Live
lending has not started, so a new event table can be introduced without back-filling
financial history.

## 2. Current business event model

```text
Group created (recurring day/time/place stored, never used again)
        |
        v
Officer goes to field  ................. not represented
Meeting occurs         ................. not represented
Attendance             ................. not represented
New client onboarded   ................. client row only, no link to the meeting
Application created    ................. application row only, no link to the meeting
Repayments collected   ................. collection batch (money only)
Meeting completed      ................. not represented (batch close ~= "money done")
Outcome / follow-up    ................. not represented
Next meeting           ................. not represented
```

## 3. Target business event model (minimum correct)

The authoritative event is **Group Meeting**, not "Operational Day". A branch or
officer day-close is an oversight layer that adds nothing until meetings themselves
are recorded — it is explicitly deferred.

```text
Recurring rule on the group (meeting_day/time/place)  -> derives DUE meetings
        |
        v
SCHEDULED  --open-->  IN_PROGRESS  --complete-->  COMPLETED
                            |                          |
                            +--postpone--> POSTPONED    +-> next meeting date
                            +--cancel----> MISSED           surfaced immediately
```

Attached to one meeting record: group, branch, officer, scheduled date/time/place,
actual start/end, attendance per active member (present / absent / excused),
the repayment batch for that meeting, clients onboarded during it, applications
taken during it, notes, and open follow-up items.

Loan lifecycle stays independent: a meeting may *create* an application; it never
approves, creates, or disburses a loan. No waiting-period rule exists in the product
configuration and none will be introduced.

## 4. Gaps

- **Data model**: no meeting entity; no attendance; no meeting-to-batch link; no
  meeting stamp on clients onboarded or applications taken; no follow-up items.
- **Backend rules**: no server-side completion, no duplicate-completion guard, no
  next-meeting derivation; batch open/close is client-driven with a JS-generated
  batch number (duplicate-number race under concurrent officers).
- **Workflow**: nowhere to open, run, or complete today's meeting; the group sheet
  dialog is a money form reached from Repayments, not from the group's meeting.
- **Visibility**: officer has no "today's meetings" list; branch manager has no view
  of scheduled / completed / missed meetings.
- **Security**: any new surface must reuse the existing business+branch scoping;
  a meeting must be forbidden from pointing at a group in another business/branch.
- **Testing**: no business-event tests for any of the above.

## 5. Remediation waves

**Wave A — Meeting as an authoritative event (data + backend)**
- `mf_group_meetings`: business_id, branch_id, group_id, loan_officer_id,
  scheduled_on/at, meeting_place, status (scheduled/in_progress/completed/
  postponed/missed), opened_at/by, closed_at/by, closing notes, next_scheduled_on.
  Grants, RLS mirroring the existing lending tables, and a trigger asserting the
  group's business_id/branch_id match the meeting's.
- `mf_meeting_attendance`: meeting_id, client_id, status, note; unique per
  (meeting, client); trigger asserting the client is an active member of the group.
- Nullable `meeting_id` on `mf_repayment_batches`, `mf_clients`, `mf_loan_applications`
  so activity done at a meeting is attributable, with a same-business guard.
- RPCs, each one migration: `mf_open_group_meeting`, `mf_complete_group_meeting`
  (idempotent — a second completion is refused with a business message; computes and
  stores the next meeting date from the group's recurring rule, or leaves it null and
  says so when no rule exists), `mf_postpone_group_meeting`.
- Completion records that money for the meeting is done by closing the linked batch
  through the existing guard; it does **not** touch accounting periods.

**Wave B — Meeting execution workflow (frontend)**
- "Meetings" entry in the Lending nav: today's meetings for the signed-in officer
  (or the branch, for managers), derived from each group's recurring day plus any
  already-created meeting rows.
- Meeting workspace: mark attendance, launch the existing group collection sheet
  (now stamped with the meeting), onboard a client / start an application from within
  the meeting, capture notes, then Complete — which shows the next meeting date.
- Errors through the existing `lendingErrorMessage` normaliser; no new formatter.

**Wave C — Next meeting and supervisor visibility**
- Next meeting shown on the group record and on the officer's list; manual override
  allowed where the group has no recurring rule.
- Branch manager list: scheduled / completed / missed today, by officer.

**Wave D — Business-event tests**
Normal meeting; new client onboarded during a meeting (client and application keep
their own independent lifecycle); no recurring rule; postponed meeting; duplicate
completion refused; cross-branch/cross-business meeting refused at the database;
direct RPC manipulation refused; loan disbursement provably unaffected by completion.

## 6. Explicit non-goals for this wave

No operational-day / branch-day-close entity. No changes to accounting periods, the
loan application lifecycle, KYC onboarding, or the Client detail/edit work. No
calendar product, no reporting suite, no notification infrastructure, no AI. No
deletion of any existing lending data or record.


===================PROGRESS STATUS============

Here's where things stand.

Already in place and verified in your system: the meeting itself is a real record. A group meeting can be opened for a date, attendance can be recorded for active members only, and the meeting can be completed with the closing time, who closed it, notes, and the next meeting date worked out from the group's regular meeting day. It can also be marked postponed (with a new date) or missed (with a reason). Completing a meeting closes any still-open collection round attached to it. Completing or postponing twice is refused, and everything is locked to the right institution, branch and officer.

What I added this round: the officer-facing pieces — a meetings data layer (open, attendance, complete, postpone, mark missed) and the meeting workspace screen where an officer marks who attended, writes notes and pending items, completes the meeting and sees the next meeting date.

What still remains:

The "Today's meetings" list page (groups due today plus meetings already opened) and its entry in the lending menu.
Passing the meeting into the existing group collection sheet so money is tagged to the meeting.
A supervisor view of upcoming, completed and missed meetings.
The business-event tests and closing out the plan file.
Nothing is broken by the pause — the meeting workspace simply isn't reachable from the menu yet. Top up credits and I'll pick up exactly at the meetings list page.
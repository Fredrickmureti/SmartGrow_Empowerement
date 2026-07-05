
## Investigation Report — Employee Lifecycle & Contract Architecture

### 1. What actually happened (execution path)

```
UI → useEmployeeContracts.create → INSERT public.employee_contracts
  └─ AFTER INSERT tg_employee_contracts_lifecycle
        → emit_employee_lifecycle_event(..., 'contract_created')
          → INSERT public.employee_lifecycle_events
             ├─ AFTER INSERT tg_hr_event_apply_garnishment      (ok)
             └─ AFTER INSERT tg_hr_event_propose_loan_skip      ◀── 400 here
```

The 400 surfaces on `POST /rest/v1/employee_contracts`, but the failure is
two hops downstream in a trigger on `employee_lifecycle_events`.

### 2. Root cause — the enum is right, the trigger is wrong

Canonical enum `public.employee_lifecycle_event_type` (migration
`20260628092841…`) defines the full lifecycle vocabulary:

```
candidate_created, application_submitted, offer_extended, offer_accepted,
offer_declined, hired, onboarding_started, onboarding_completed,
probation_started, probation_ended, probation_extended,
contract_created, contract_activated, contract_renewed, contract_amended,
contract_expired, salary_revised, position_changed,
department_transferred, location_transferred, manager_changed,
promoted, demoted, suspended, reinstated,
leave_of_absence_started, leave_of_absence_ended,
termination_initiated, terminated, offboarding_started,
offboarding_completed, final_settlement_paid,
archived, unarchived, custom
```

The trigger function `public.tg_hr_event_propose_loan_skip` (last
rewritten in `20260705105345…`) references **two phantom values** that
were never members of this enum:

```sql
-- line 22
IF NEW.event_type IN ('reinstated','leave_of_absence_ended','returned_from_leave') THEN
-- line 44
IF NEW.event_type NOT IN ('leave_of_absence_started','suspended','unpaid_leave_started') THEN
```

Postgres coerces every string literal in an `IN (…)` against an enum
column to that enum type at plan time. `'returned_from_leave'` and
`'unpaid_leave_started'` fail that coercion, so **every** insert into
`employee_lifecycle_events` fails — regardless of the actual event
being emitted. The reported "contract_created" insert never even
reaches the enum check; it dies on planning of the IF condition.

Blast radius: every HR lifecycle emission (contract create/activate/
renew/amend/expire, hire, termination, leave start/end, reinstate,
onboarding, salary revision, position/department/location/manager
change). Payroll, garnishment, and loan-skip automations that hang off
these events are silently dead too.

The two phantom identifiers are lifecycle concepts the loan-skip
policy needs to react to, but the canonical vocabulary already
expresses them:

| Phantom used in trigger | Canonical enum member |
|---|---|
| `returned_from_leave`  | `leave_of_absence_ended` (already listed alongside it — dead code) |
| `unpaid_leave_started` | Not modelled distinctly; today collapsed into `leave_of_absence_started` + payload flag |

### 3. Lifecycle architecture, as it actually exists

- **Definition**: one enum (`employee_lifecycle_event_type`) — good, single source of truth.
- **Storage**: one table (`employee_lifecycle_events`, columns per Ch. 03 manual) — good.
- **Emit API**: one `SECURITY DEFINER` function
  `public.emit_employee_lifecycle_event(...)` — good.
- **Producers** (traced through migrations):
  - `tg_employee_contracts_lifecycle` (contract create/activate/renew/amend/expire)
  - `tg_employee_onboarding_lifecycle`
  - `tg_employees_lifecycle` (hire/terminate/rehire/archive)
  - Position/department/location change triggers on `employee_position_history`
  - Leave approval path (`20260628115322…`, `…115628…`, `…171052…`)
  - Migration-inserted historical events (backfill)
- **Consumers**:
  - Payroll — loan skip proposals (`tg_hr_event_propose_loan_skip`)
  - Garnishments — `tg_hr_event_apply_garnishment`
  - UI — `useLifecycleEvents`, `LifecyclePipelinePage`, `LifecycleTimelinePage`
  - Reporting/audit — read-only via the same table
- **Architectural drift found**: the loan-skip consumer trigger was
  written against a **different, older lifecycle vocabulary** than the
  one the producers and enum agree on. This is drift in the *consumer*,
  not evidence of two competing engines.

### 4. Is the contract subsystem behind Payroll?

Partially, but not in the way suspected. The lifecycle spine is in
place and every major HR business event does emit through the single
engine. The gaps that remain (documented in `mem/features/employee-module-followup.md`
and `docs/manuals/hr-payroll/03-org-structure.md`) are:

- No DB UNIQUE guard for "one running contract per employee" — enforced only in UI.
- `contract_compensation_components` not yet consumed by payroll (falls back to top-level `wage`).
- Merit-cycle → `employee_compensation_history` wiring is UNVERIFIED.
- No approval workflow wired on compensation changes.

These are real, but **out of scope for this fix** — none of them cause
the current 400. Recording them in the follow-up memory is enough.

### 5. Fix — surgical, aligns consumer with canonical vocabulary

Rewrite `public.tg_hr_event_propose_loan_skip` so it references only
values that exist in `employee_lifecycle_event_type`:

```sql
-- cancel branch
IF NEW.event_type IN ('reinstated','leave_of_absence_ended') THEN ...

-- propose branch
IF NEW.event_type NOT IN ('leave_of_absence_started','suspended') THEN
  RETURN NEW;
END IF;

v_category := CASE NEW.event_type
  WHEN 'leave_of_absence_started' THEN 'leave_of_absence'
  WHEN 'suspended' THEN 'suspension'
  ELSE 'leave_of_absence' END;
```

No unpaid-leave-specific branch is lost — the current enum doesn't
distinguish unpaid vs paid leave at the lifecycle layer; that
distinction lives in `leave_requests` / payslip inputs. If the
business genuinely needs `unpaid_leave_started` / `returned_from_leave`
as first-class lifecycle events, that is a **separate, deliberate
vocabulary extension** requiring: enum additions, producer wiring in
the leave-approval trigger, docs, and UI pipeline pages — not a
back-door reference from a consumer trigger.

### 6. Regression guard added in the same migration

A pgTAP-style guard mirroring the existing
`employee_contracts_no_stale_field_refs_test.sql` pattern:

**`supabase/tests/hr_lifecycle_event_no_phantom_enum_refs_test.sql`** —
fails CI if any `public` function references a string literal in an
`IN (…)` / `= '…'` / `CASE WHEN … =` comparison against an
`employee_lifecycle_event_type`-typed column when that literal is not
a member of the enum. Prevents this exact drift class from recurring.

### 7. What we are NOT changing

- No enum additions. The enum is the canonical vocabulary; adding
  `returned_from_leave` / `unpaid_leave_started` just to satisfy a
  broken consumer would entrench the drift.
- No producer changes. Every producer already uses canonical values.
- No frontend edits. `EmployeeContractsTab.handleCreate` is correct.
- No changes to `emit_employee_lifecycle_event`, `tg_employee_contracts_lifecycle`, or `tg_hr_event_apply_garnishment`.
- No changes to `BackgroundSyncManager` — the observed `401` on
  `HEAD /rest/v1/` is expected reachability-probe behaviour.

### 8. Deliverable (single migration)

1. `CREATE OR REPLACE FUNCTION public.tg_hr_event_propose_loan_skip` with the phantom-value references removed.
2. New guard test `supabase/tests/hr_lifecycle_event_no_phantom_enum_refs_test.sql`.

### 9. Recommended follow-ups (separate work, not this PR)

- Decide whether `unpaid_leave_started` / `returned_from_leave` should
  become first-class enum members. If yes: extend enum + wire producers
  in the leave-approval trigger + add UI pipeline pages.
- Add the DB-level "single running contract per employee" partial
  unique index.
- Verify `contract_compensation_components` payroll consumption.
- Wire merit-cycle approvals into `employee_compensation_history` with
  the existing `submitted_at/approved_at` governance columns.

### 10. Risk assessment

Very low. The function only removes references to values that Postgres
cannot resolve today — no live code path can dispatch on them because
producers cannot emit them. Removing the dead references restores
every HR lifecycle emission and every downstream consumer (payroll
loan-skip, garnishments, timeline, reporting) with zero behavioural
change for currently-in-use event types.

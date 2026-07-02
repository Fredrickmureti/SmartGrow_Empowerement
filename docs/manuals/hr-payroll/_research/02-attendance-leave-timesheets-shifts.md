# Research: Attendance / Leave / Timesheets / Shifts

Source: sub-agent investigation `sub_rb0j2pgp`. Verified read-only against current codebase. Used as input for chapter `04-attendance-leave-timesheets.md` of the operational manual.

---

## 1. ATTENDANCE SUBSYSTEM

### Purpose
Records employee presence via clock-in/out, breaks, and corrections. Drives downstream payroll via `payroll_work_entries`. Supports multi-source capture with anti-fraud controls.

### Capture Sources

| Source | Entry Point | Auth |
|---|---|---|
| Web self-clock | `src/pages/hr/EmployeeSelfService.tsx` → `AttendanceClockWidget` | JWT, device fingerprint + optional geolocation + optional selfie |
| Kiosk | `src/hooks/hr/useKioskClock.ts:24` → RPC `attendance_kiosk_clock` | Kiosk PIN |
| Biometric device | Edge fn `biometric-ingest` → HMAC-SHA256 (`x-device-id`, `x-timestamp`, `x-signature`) | Per-device HMAC secret `attendance_devices.hmac_secret` (bytea) |
| Manager manual entry | `src/pages/hr/Attendance.tsx` Manual Entry dialog | JWT + `attendance:write` |
| Correction | `CorrectionRequestDialog` → RPC `attendance_request_correction` → `attendance_corrections` | Employee submits; manager approves via `CorrectionReviewPanel` |

### Core Tables
- `attendance` — `clock_in/out`, `status`, `branch_id`, `source`, `locked`, anomaly flags
- `attendance_breaks` — `break_type ∈ {rest, meal, other}`
- `attendance_corrections` — `status ∈ {pending, approved, rejected}`, proposed values, reviewer
- `attendance_events` — raw biometric event stream
- `attendance_devices` — registry: `vendor`, `serial`, `public_id`, `hmac_secret`, `status`, `last_seen_at`
- `attendance_device_trust` — per-device-per-employee trust (only enforced inside RPC, no UI traced)
- `attendance_ingest_log` — replay-dedup via `payload_hash` (SHA-256 of raw body)
- `attendance_settings` — `auto_checkout_after_hours`, `geofence_required`, `selfie_required`, `device_binding_required`, `enforce_shift_window`, `block_clock_in_on_approved_leave`, `require_ot_preapproval`, `impossible_travel_action ∈ {flag, deny}`
- `attendance_saved_views` — per-user roster filter presets

### RPC chain (clock-in)
```
useAttendanceActions.clockIn()                     src/hooks/hr/useAttendanceActions.ts:87
  → getDeviceFingerprint() + getCurrentPosition()  src/lib/attendance/deviceFingerprint.ts
  → [opt] captureAndUploadSelfie()                 src/lib/attendance/captureSelfie.ts
  → supabase.rpc("attendance_clock_in", { _employee_id, _branch_id, _source:"web",
      _device_fp, _user_agent, _lat, _lng, _accuracy_m, _selfie_path, _kiosk_pin })
```
Error mapping (`useAttendanceActions.ts:14-42`): `ALREADY_CLOCKED_IN`, `ON_APPROVED_LEAVE`, `OUTSIDE_GEOFENCE`, `SELFIE_REQUIRED`, `UNTRUSTED_DEVICE`, `OUTSIDE_SHIFT_WINDOW`, `IMPOSSIBLE_TRAVEL`, `DUPLICATE_RECENT_ATTEMPT`, `SESSION_CLOSED`, `locked`.

### Correction approval chain
```
Employee → rpc("attendance_request_correction") → status="pending"
Manager  → CorrectionReviewPanel approve/reject → status="approved"/"rejected"
On approve: attendance row updated with proposed values.
```
Hook: `src/hooks/hr/useAttendanceCorrections.ts`

### Auto-checkout (edge fn `attendance-missed-checkout`, ~15 min cron)
1. Query `attendance WHERE clock_out IS NULL`.
2. Per-business `attendance_settings.auto_checkout_after_hours` (default 16h).
3. RPC `attendance_auto_checkout` closes stale rows.
4. Inserts `notifications` rows for employee + manager.

### Payroll integration
```
useGenerateAttendanceWorkEntries.mutate(runId)         src/hooks/payroll/useGenerateAttendanceWorkEntries.ts:25
  → rpc("attendance_generate_work_entries", { _run_id })
      - locks attendance rows (attendance.locked=true)
      - rolls up approved hours + leave into payroll_work_entries
      - returns { employees, hours, overtime_hours, locked_attendance_rows }
  → invalidates ["payroll-runs"], ["payroll-work-entries"], ["attendance"]
```

### State transitions (attendance.status)
`present → late → overtime → absent → on_leave → holiday`. Anomaly detection in `src/lib/attendance/anomalies.ts` rendered via `AnomalyBadge`.

### Key UI files
- `src/pages/hr/Attendance.tsx` — manager roster, KPI strip, bulk lock, EmployeeDayDrawer
- `src/pages/hr/AttendanceApprovals.tsx` — correction queue
- `src/pages/hr/AttendanceAudit.tsx` — audit log
- `src/pages/hr/AttendanceDevices.tsx` — device registry CRUD
- `src/pages/hr/AttendanceMyTeam.tsx` — team-scoped roster
- `src/components/attendance/AttendanceClockWidget.tsx`, `MyDayProgressCard.tsx`, `MyWeekStrip.tsx`

---

## 2. LEAVE SUBSYSTEM

### Tables
- `leave_requests` — `status ∈ {draft, pending, pending_second_approval, approved, rejected, cancelled}`, `days_requested`, `start/end_date`, `start/end_period` (half-day), `first_approver_id`, `second_approver_id`
- `leave_types` — `code`, `color`, `requires_second_approval` (UNVERIFIED column name), `max_days_per_request`, accrual
- `leave_allocations` — per-period balance; balance via RPC `get_leave_balance`
- `public_holidays` — org/business-scoped; used by `calculate_leave_days`

### Two-level approval chain
```
Employee submitRequest()                       → status="pending" + send-leave-email("submitted")
Manager L1 rpc("approve_leave_request_level1") → "pending_second_approval" if L2 required, else "approved"
HR L2     rpc("approve_leave_request_level2")  → "approved"
Reject:   direct UPDATE status="rejected", rejected_by, rejection_reason
Cancel:   direct UPDATE status="cancelled"
```
Hook: `src/hooks/leave/useLeaveRequests.ts`. Permissions: `can("approveLeave")`, `can("approveLeaveLevel2")`.

### Email + reminders
- `send-leave-email` edge fn: invoked fire-and-forget. Honours `notification_preferences.email_enabled` (category `"leave"`). Delegates to `send-email`. Also writes `notifications` row.
- `check-leave-expiry` daily cron: queries approved leaves ending in 0-2 days; emails + in-app notifications. **No idempotency guard.**

### RPC inventory
| RPC | Purpose |
|---|---|
| `get_next_leave_request_number` | `LR-NNNN` sequence |
| `calculate_leave_days(start,end,start_period,end_period)` | Exclude weekends + `public_holidays` |
| `check_leave_overlap(employee_id,start,end)` | Conflict detection |
| `approve_leave_request_level1(p_request_id)` | L1 decision |
| `approve_leave_request_level2(p_request_id)` | L2 final |
| `get_leave_balance(employee_id, leave_type_id)` | Balance from allocations |

### UI files
- `src/components/leave/LeaveRequestForm.tsx`
- `src/components/leave/LeaveApprovalList.tsx`, `LeaveApprovalDialog.tsx`
- `src/components/leave/LeaveBalanceCard.tsx`, `TeamLeaveCalendar.tsx`
- `src/hooks/leave/useLeaveAllocations.ts`, `useLeaveTypes.ts`, `usePublicHolidays.ts`, `useTeamLeaveRequests.ts`

---

## 3. TIMESHEETS SUBSYSTEM

### Tables
- `timesheets` — day-level: `date`, `hours`, `start_time/end_time`, `project_id`, `task_id`, `is_billable`, `billing_rate`, `billing_amount`, `status`, `invoice_id`, `is_invoiced`, `payroll_locked`, `correction_of`
- `timesheet_submissions` — week aggregate: `period_start/end`, `total_hours`, `billable_hours`, `status`
- `timesheet_audit_log` — `created`, `status_change`, `payroll_locked`, `payroll_unlocked`, `invoiced`, `invoice_reverted`
- `timesheet_settings` — business-scoped (UNVERIFIED schema)

### Approval chain
```
Employee  rpc("submit_timesheet_period",   {employee_id, period_start, period_end}) → "submitted"
Manager   rpc("approve_timesheet_submission", {submission_id})                       → "approved" + audit "status_change"
Manager   rpc("reject_timesheet_submission",  {submission_id, reason})              → "rejected"
```
Reminder: `check-missing-timesheets` weekly cron — idempotent via 7-day dedup on `notifications`.

### Payroll lock
`attendance_generate_work_entries` locks `timesheets.payroll_locked=true` within the run period and writes `payroll_locked` audit action.

### Billing path
`BillFromTimesheetsDialog` (`src/components/timesheets/BillFromTimesheetsDialog.tsx`):
1. Query `timesheets WHERE is_billable=true AND is_invoiced=false AND status='approved'`.
2. Group by project, sum hours × billing_rate.
3. Create invoice lines via `useInvoices`.
4. `rpc("mark_timesheets_invoiced", invoice_id, ids[])` → `is_invoiced=true`.
5. Audit row `invoiced`.

Also: edge fn `invoice-project-timesheets` (server-side path; integration with client path UNVERIFIED).

### UI files
- `src/components/timesheets/WeeklyTimesheetGrid.tsx`, `TimesheetEntryForm.tsx`
- `src/components/timesheets/TimesheetApprovalList.tsx`, `TimesheetApprovalDialog.tsx`
- `src/components/timesheets/TimesheetAuditPanel.tsx`, `BillFromTimesheetsDialog.tsx`
- `src/hooks/timesheets/useTimesheets.ts`, `useTimesheetAudit.ts`, `useTimesheetSettings.ts`, `useTimesheetInboxCounts.ts`

---

## 4. SHIFTS SUBSYSTEM

### Tables
- `shifts` — template: `start_time`, `end_time`, `break_minutes`, `paid_break`, `crosses_midnight`, `night_differential_pct`, `color`, `is_active`
- `shift_assignments` — `employee_id × assignment_date × shift_id`, `status ∈ {planned, published, swapped, cancelled, completed, no_show}`, `source ∈ {planned, swap, on_call, overtime, adjusted}`, `published_at`
- `shift_swap_requests` — `requester/target_employee_id`, `requester/target_assignment_id`, `status ∈ {pending, target_accepted, target_declined, approved, rejected, cancelled, applied}`
- `overtime_requests` — `employee_id`, `ot_date`, `requested_hours`, `status ∈ {pending, approved, rejected, cancelled}`
- `work_schedules`, `work_schedule_days` — defined but no traced consumer (UNVERIFIED)

### Assignment flow
```
useShiftAssignments.assign({employee_id, shift_id, assignment_date}) → status="planned"
useShiftAssignments.updateStatus({id, status:"published"})          → "published", published_at=now()
Employees see via useMyShiftToday (src/hooks/hr/useMyShiftToday.ts)
```

### Swap flow
```
A: useShiftSwaps.create({requester_assignment_id, target_employee_id, target_assignment_id}) → "pending"
B: useShiftSwaps.respond({id, accept:true})                                                  → "target_accepted"
M: useShiftSwaps.decide({id, approve:true})                                                  → "approved"
(UNVERIFIED): no client code observed setting applied_at or swapping assignments — likely DB trigger or missing step.
```

### Overtime flow
```
Employee  rpc("overtime_request_submit") → "pending"
Manager   rpc("overtime_request_decide", {_request_id,_approve,_notes}) → "approved"/"rejected"
attendance_settings.require_ot_preapproval gates whether clock-in is blocked for OT hours.
```

### Clock-in shift enforcement
`attendance_settings.enforce_shift_window=true` → `attendance_clock_in` checks `shift_assignments` for the day and returns `OUTSIDE_SHIFT_WINDOW` if outside tolerance.

### UI files
- `src/pages/hr/Shifts.tsx`, `src/pages/hr/Roster.tsx`, `src/pages/hr/AttendanceSettingsPage.tsx`
- `src/hooks/useShifts.ts`, `src/hooks/hr/useOvertimeRequests.ts`, `src/hooks/hr/useMyShiftToday.ts`

---

## CROSS-SUBSYSTEM DATA FLOW

```
Biometric Device ──HMAC POST──▶ biometric-ingest ─▶ attendance_events / attendance ─┐
Web / Kiosk      ──RPC──▶ attendance_clock_in/out                                    │
                 ──RPC──▶ attendance_break_start/end ─▶ attendance_breaks            │
Corrections      ──RPC──▶ attendance_request_correction ─▶ attendance_corrections ───┤
Leave            ──RPC──▶ approve_leave_request_level1/2 ─▶ leave_requests ──────────┤
Shifts           ──DB──▶ shift_assignments [enforced by clock_in RPC]               │
                                                                                     ▼
                            rpc("attendance_generate_work_entries")
                              ├── locks attendance rows
                              ├── reads leave_requests (approved)
                              └── writes payroll_work_entries
                                     └─▶ compute-payroll edge fn
```

## Risks / UNVERIFIED

| # | Sev | Finding |
|---|---|---|
| R1 | HIGH | `rejectRequest` in `useLeaveRequests.ts` is direct UPDATE (not RPC) — no server balance rollback or second-approver guard. |
| R2 | HIGH | `check-leave-expiry` has no idempotency — daily cron could double-send if triggered twice. |
| R3 | MED  | `send-leave-email` is fire-and-forget — delivery failures invisible to user. |
| R4 | MED  | `attendance_device_trust` — no UI for HR to review trust requests; only error shown to employee. |
| R5 | MED  | `work_schedules` / `work_schedule_days` — no consumer traced. |
| R6 | MED  | Shift-swap `applied_at` — no client code performs actual swap after approval. |
| R7 | LOW  | `useLeaveRequests` fetches up to 5000 rows in one query. |
| R8 | LOW  | Biometric `occurredAt` accepts 30 days back; could affect payroll-locked periods. |
| R9 | UNVERIFIED | `invoice-project-timesheets` vs client `BillFromTimesheetsDialog` consistency. |
| R10 | UNVERIFIED | `timesheet_settings` field names/defaults. |

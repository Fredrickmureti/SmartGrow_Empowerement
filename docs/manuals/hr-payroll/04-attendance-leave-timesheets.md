# 04 · Attendance, Leave, Timesheets & Shifts

## Purpose
Every minute that turns into payroll money. This chapter shows how time is captured, approved, locked, and rolled into `payroll_work_entries`.

## Attendance

### Capture sources

| Source | Entry point | Authentication |
|---|---|---|
| Web self-clock | `AttendanceClockWidget` in `/me/attendance` | JWT + device fingerprint + optional geolocation + optional selfie |
| Kiosk | `useKioskClock.ts:24` → RPC `attendance_kiosk_clock` | Kiosk PIN hashed in `employee_credentials.kiosk_pin_hash` (bcrypt) |
| Biometric device | Edge fn `biometric-ingest` | Per-device HMAC-SHA256; secret in `attendance_devices.hmac_secret` |
| Manager manual | `Attendance.tsx` → Manual Entry dialog | `attendance:write` permission |
| Correction | `CorrectionRequestDialog` → RPC `attendance_request_correction` | Employee submits, manager reviews |

### Clock-in pipeline
```text
useAttendanceActions.clockIn()
  └─► deviceFingerprint + geolocation [+ selfie upload]
        └─► supabase.rpc("attendance_clock_in", { ...inputs })
              ├─ enforces `attendance_settings` (geofence, selfie, device trust, shift window, on-leave block, OT pre-approval)
              ├─ raises one of: ALREADY_CLOCKED_IN, ON_APPROVED_LEAVE, OUTSIDE_GEOFENCE, SELFIE_REQUIRED,
              │                UNTRUSTED_DEVICE, OUTSIDE_SHIFT_WINDOW, IMPOSSIBLE_TRAVEL,
              │                DUPLICATE_RECENT_ATTEMPT, SESSION_CLOSED
              └─ INSERTs `attendance` row with `source`, anomaly flags
```

### Tables
`attendance`, `attendance_breaks`, `attendance_corrections`, `attendance_events`, `attendance_devices`, `attendance_device_trust`, `attendance_ingest_log` (replay-dedup via SHA-256 of payload), `attendance_settings`, `attendance_saved_views`.

### Auto-checkout
Edge fn `attendance-missed-checkout` (cron ~15 min): closes stale `attendance` rows beyond `auto_checkout_after_hours` (default 16h) via RPC `attendance_auto_checkout`. Notifies the employee + manager.

### Corrections
- Employee submits via RPC `attendance_request_correction` (writes `attendance_corrections.status='pending'`).
- Manager reviews via `CorrectionReviewPanel`; on approve the `attendance` row is updated with the proposed values.

### Payroll integration
When a payroll run starts, the user (or engine) calls:
```text
rpc("attendance_generate_work_entries", { _run_id })
  ├─ LOCKs attendance rows (`attendance.locked = true`)
  ├─ rolls up approved hours + approved leave into `payroll_work_entries`
  └─ returns { employees, hours, overtime_hours, locked_attendance_rows }
```

## Leave

### Tables
`leave_requests` (`status ∈ {draft, pending, pending_second_approval, approved, rejected, cancelled}`, half-day flags, `first_approver_id`, `second_approver_id`), `leave_allocations`, `leave_types` (`code`, `color`, `max_days_per_request`, accrual), `public_holidays`.

### Two-level approval chain
```text
Employee submitRequest()                       → "pending"          + send-leave-email("submitted")
Manager L1 rpc(approve_leave_request_level1)   → "pending_second_approval" if type requires L2, else "approved"
HR L2     rpc(approve_leave_request_level2)    → "approved"        + send-leave-email("approved")
Reject:    direct UPDATE status="rejected"     (Chapter 13 risk: not an RPC; no server balance rollback)
Cancel:    direct UPDATE status="cancelled"
```

Permissions: `can("approveLeave")`, `can("approveLeaveLevel2")`.

### RPCs you can rely on
- `get_next_leave_request_number` — sequential `LR-NNNN`.
- `calculate_leave_days(start, end, start_period, end_period)` — excludes weekends + `public_holidays`.
- `check_leave_overlap(employee_id, start, end)` — conflict detection.
- `get_leave_balance(employee_id, leave_type_id)`.

### Reminders
Edge fn `check-leave-expiry` (daily cron) emails approved leaves ending in 0-2 days. **No idempotency guard** today (Chapter 13).

## Timesheets

### Tables
`timesheets` (day-level: `date`, `hours`, `project_id`, `task_id`, `is_billable`, `billing_rate`, `payroll_locked`, `is_invoiced`, `correction_of`), `timesheet_submissions` (week aggregate), `timesheet_audit_log`, `timesheet_settings`.

### Approval chain
```text
Employee  rpc(submit_timesheet_period, {employee_id, period_start, period_end}) → "submitted"
Manager   rpc(approve_timesheet_submission, {submission_id})                    → "approved" + audit "status_change"
Manager   rpc(reject_timesheet_submission,  {submission_id, reason})           → "rejected"
```

Missing-timesheet reminder: `check-missing-timesheets` weekly cron, idempotent via 7-day dedup on `notifications`.

### Payroll lock
When `attendance_generate_work_entries` runs, in-period `timesheets.payroll_locked=true` is set; a `payroll_locked` row is appended to `timesheet_audit_log`.

### Billing path
`BillFromTimesheetsDialog.tsx` lists approved billable, uninvoiced rows, builds invoice lines, then calls RPC `mark_timesheets_invoiced(invoice_id, ids[])` → server lock. Audit row `invoiced` is written.

## Shifts

### Tables
`shifts` (template), `shift_assignments` (employee × date × shift), `shift_swap_requests`, `overtime_requests`, `work_schedules` / `work_schedule_days` (defined but not consumed by any traced UI — UNVERIFIED).

### Flows
- **Assign** `useShiftAssignments.assign` → status `planned` → `updateStatus → "published"`.
- **Swap** Employee A creates → Employee B accepts → Manager decides. **The actual assignment swap on approval is not visible in client code** — likely a DB trigger or missing step (Chapter 13).
- **Overtime** `overtime_request_submit` → `overtime_request_decide`. If `attendance_settings.require_ot_preapproval=true`, clock-in is blocked for OT hours without an approved request.

### Clock-in enforcement
`attendance_settings.enforce_shift_window=true` → clock-in checks `shift_assignments` for the day and returns `OUTSIDE_SHIFT_WINDOW` outside tolerance.

## Cross-subsystem data flow
```text
Biometric device ─HMAC POST→ biometric-ingest ─► attendance_events / attendance ─┐
Web / Kiosk      ─RPC→ attendance_clock_in/out                                    │
                 ─RPC→ attendance_break_start/end ─► attendance_breaks            │
Corrections      ─RPC→ attendance_request_correction ─► attendance_corrections ───┤
Leave            ─RPC→ approve_leave_request_level1/2 ─► leave_requests ─────────┤
Shifts           ─DB→ shift_assignments [enforced by clock_in RPC]               │
                                                                                  ▼
                          rpc("attendance_generate_work_entries")
                            ├─ locks attendance rows
                            ├─ reads approved leave_requests
                            └─ writes payroll_work_entries  ──► compute-payroll
```

> Full evidence: `./_research/02-attendance-leave-timesheets-shifts.md`.

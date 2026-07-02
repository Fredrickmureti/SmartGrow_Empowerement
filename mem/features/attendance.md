---
name: Attendance enterprise model
description: Forensic clock RPCs, geofence/selfie/device-trust policies, breaks, overtime preapproval, hardware HMAC ingestion, shift-window + impossible-travel + duplicate guards, append-only event log, portal-safe hook split, canonical error codes
type: feature
---

# Attendance — enterprise model

## Hook split — NEVER violate

- Portal / `/me/*` surfaces use `useAttendanceActions()` (RPC-only, no list read, no `currentBusiness` requirement, no `employees` embed). It silently gathers device fingerprint + GPS + UA on every clock action.
- Admin / HR surfaces use `useAttendance()` which embeds `employees(...)` — never import this hook from `src/pages/me/` or `src/components/attendance/AttendanceClockWidget.tsx`.

Violating this split reproduces the production 400 on `/me/attendance` (portal users cannot read `employees` via RLS).

## Clock RPCs

`attendance_clock_in` / `attendance_clock_out` — SECURITY DEFINER. Persist forensic columns and append every attempt (allow/deny/flag) to `attendance_events` via `attendance_log_event`.

Business resolution: `business_id` is taken from `employees.business_id` first, then falls back to `branches.business_id` of the resolved branch. Raises `EMPLOYEE_BUSINESS_UNRESOLVED` if neither yields a value. Never derive business from the auth session.

Enforcement order (each step gated on a per-business `attendance_settings` flag, all default OFF unless noted):
1. `ALREADY_CLOCKED_IN` (always)
2. `DUPLICATE_RECENT_ATTEMPT` (`min_clock_interval_seconds`, default 30)
3. `IMPOSSIBLE_TRAVEL` (`max_speed_kmh`, default 200; `impossible_travel_action` = 'flag'|'deny')
4. `ON_APPROVED_LEAVE` (`block_clock_in_on_approved_leave`, default true)
5. `OUTSIDE_SHIFT_WINDOW` (`enforce_shift_window`, with `early_clock_in_minutes`/`late_clock_in_minutes`)
6. `GEO_REQUIRED` / `OUTSIDE_GEOFENCE` / `NO_GEOFENCE_DEFINED` (`geofence_required`)
7. `SELFIE_REQUIRED` (`selfie_required`)
8. Device trust (`device_binding_required` + `device_trust_action` = 'flag' (default) | 'deny'). In `flag` mode (Odoo-style), an unknown device is auto-trusted on first punch, the attendance row is marked `requires_review=true` with reason `NEW_DEVICE_AUTOTRUSTED`, and the punch proceeds. In `deny` mode, raises `UNTRUSTED_DEVICE`. `DEVICE_REVOKED` always denies regardless of mode.
9. `KIOSK_PIN_INVALID` (`source='kiosk' AND kiosk_pin_required`)

Flagged punches land on `attendance.requires_review` (bool) and `attendance.review_reasons` (text[]). Vocabulary: `IMPOSSIBLE_TRAVEL`, `NEW_DEVICE_AUTOTRUSTED`, `NO_DEVICE_FINGERPRINT`. Each reason also emits a `flag` event on `attendance_events`.

These error strings are the contract — client `mapRpcError` in `useAttendanceActions.ts` keys friendly messages on them.

## Breaks

`attendance_breaks` (one open per attendance enforced by unique partial index). Mutate only via `attendance_break_start(_attendance_id,_break_type,_source,_lat,_lng,_device_fp,_notes)` and `attendance_break_end(_break_id,_lat,_lng,_device_fp)`. Closing recomputes `attendance.break_duration_minutes`. Both append to `attendance_events`.

## Overtime pre-approval

`overtime_requests` (status pending|approved|rejected|cancelled). Submit via `overtime_request_submit`; HR decides via `overtime_request_decide(_id,_decision,_reason)`. When `attendance_settings.require_ot_preapproval=true`, payroll must only count OT hours backed by an approved request.

## Holiday auto-stamp

Insert on `public_holidays` fires `public_holidays_stamp_trigger` → `attendance_stamp_holidays(_from,_to)` which inserts `attendance.status='holiday'` rows for active employees in scope, skipping any day that already has a row. Backfill RPC is callable manually for a date range.

## Append-only event log

`attendance_events` is append-only by both REVOKE and trigger (`attendance_events_block_mutation`). Never UPDATE or DELETE; never grant INSERT directly — only the SECURITY DEFINER `attendance_log_event` helper inserts. HR sees all events in their org via `user_has_module_permission(..., 'attendance', 'read')`; employees see their own.

## Selfies

Private bucket `attendance-selfies`. Path `{org_id}/{employee_id}/{yyyy}/{mm}/{uuid}.jpg`. RLS on `storage.objects`: employee can upload/read their own (verified by joining `employees.user_id = auth.uid()` against path segments); HR with `attendance.read` can read all. Clients upload bytes and pass only the path to the RPC.

## Device trust (user devices, not hardware terminals)

`attendance_device_trust(employee_id, device_fingerprint UNIQUE per pair)`. Transitions only via `attendance_device_trust_approve(_device_id)` / `attendance_device_trust_revoke(_device_id)` — both require `attendance.write` permission.

## Hardware terminal ingestion (ZKTeco / Hikvision / Suprema / RFID / kiosk)

`attendance_devices(public_id, hmac_secret BYTEA, vendor, serial, status)`. HR registers via `attendance_device_register(_vendor,_serial,_branch_id,_metadata)` which returns the `public_id` + `hmac_secret_hex` ONCE (never re-exposed). Status managed via `attendance_device_set_status`.

External terminals POST to **`/api/public/attendance/ingest`** (TanStack server route under `src/routes/api/public/attendance.ingest.ts`):
- Headers: `x-device-id`, `x-signature` (hex HMAC-SHA256 of body using the device secret), `x-timestamp` (unix seconds, ±300s window).
- Body: `{employee_ref, kind: 'in'|'out'|'break_start'|'break_end', ts, lat?, lng?, confidence?, photo_url?}`.
- Resolves employee by `employees.external_attendance_ref` (unique per org), invokes the existing SECURITY DEFINER RPCs via `supabaseAdmin` (imported inside the handler to keep client bundles clean).
- Idempotent: `attendance_ingest_log(device_public_id, payload_hash)` UNIQUE — replays return the prior outcome.

## Payroll integration

- `compute-payroll` 409s on pending corrections in the window.
- Aggregation writes one `payroll_work_entries` row per employee, back-fills `attendance.work_entry_id`, and locks the period via `attendance_lock_for_period(_business_id,_from,_to,_payroll_run_id,_employee_ids)`.
- OT pre-approval: when `require_ot_preapproval=true`, only `overtime_requests.status='approved'` hours count as OT; the rest flag on the run.

## Out of scope (future)

Mobile offline queue, in-process biometric SDKs (always use HMAC ingestion + vendor middleware instead), WhatsApp/SMS bot, split-shift double-session UX. The architecture above is additive — these land as new RPCs/routes without touching the contract.

# 2026-06-08 — Attendance cross-module UX parity (B5)

## Re-audit verdict on the previous agent's Wave 3b claims

Every Wave 3b claim verified against the codebase and the existing
`attendance-ux.test.ts` + `attendance-wave3b.test.ts` guards (11/11 green):

| Claim | Status |
| --- | --- |
| `AttendanceSubNav` (Operations / Inbox / Insights + Setup dropdown) | Verified |
| `AttendanceKpiStrip`, `LivePresenceCard`, `EmployeeDayDrawer`, `AnomalyBadge` per-code ack, `SavedViewMenu`, `EmployeeTrendDrawer`, approvals hotkeys (J/K) | Verified |
| `/me/attendance` Today/History split + manager triage banner | Verified |
| Legacy `/team`, `/corrections`, `/overtime` URLs redirect into the new hubs | Verified |

What the previous agent missed (and what this wave fixes): the user's explicit
note that Timesheets, Time-off (`/hr/leave`) and the Employees → Attendance
jump still ship pre-overhaul chrome, so the operator visibly drops from a
clean module into a cluttered one.

## Shipped in B5

### B5.1 — Attendance gap closeouts
- **Manager triage banner gated on `manageAttendance`** (`src/pages/me/MyAttendance.tsx`). A team-lead employee without the permission no longer sees a Review button that would 403.
- **Setup dropdown badge de-duplicated** (`src/components/attendance/AttendanceSubNav.tsx`). The disabled-devices count renders on the trigger only, matching the Inbox group pattern.

### B5.2 — Timesheets parity
- New `useTimesheetInboxCounts` hook (`src/hooks/timesheets/useTimesheetInboxCounts.ts`) — pending count from `timesheet_submissions.status = 'submitted'`, scoped to org/business, with realtime invalidation.
- New `TimesheetsSubNav` component mirroring Attendance: Operations (Approvals · Team week · By project) / Inbox / Insights / Setup.
- Mounted in `src/apps/timesheets/routes.tsx`.

### B5.3 — Time-off parity
- New `useLeaveInboxCounts` hook (pending + pending second-level) with realtime invalidation.
- New `LeaveSubNav` component using the same chrome. Operations links use `?tab=…` so the existing `LeaveDashboard` tabs respond without a full route split (deferred — see below).
- Mounted in `src/apps/hr/sub/TimeOffRoutes.tsx`.

### B5.5 — Generalized Inbox card
- `src/components/hr/ModuleInboxCard.tsx` is a one-component, three-variant card (`attendance` | `timesheets` | `leave`) driven by the three inbox-count hooks.
- `HRDashboard.tsx` now surfaces all three side-by-side, so a manager opening the HR overview sees every queue waiting on them without scrolling through alerts.

### B5.6 — Architecture guard
- `src/test/architecture/cross-module-ux-parity.test.ts` — 7 assertions covering the new sub-navs, the inbox hooks, the HRDashboard mount, the banner gating, the Setup badge dedupe, and the inbox card wiring. The existing 11 Attendance guards remain green.

## Deferred (documented as known follow-ups)

These were in the approved plan but require larger refactors and are tracked
for a follow-up wave:

- **B5.3 (heavy)** — Splitting `LeaveDashboard` into `/hr/leave`, `/hr/leave/team`, `/hr/leave/approvals`, `/hr/leave/reports`, `/hr/leave/settings` proper routes (current sub-nav uses `?tab=…` query params against the existing single-page tabs).
- **B5.4** — `MeAppShell` unification with a shared self-service sub-nav (Attendance · Timesheets · Time-off · Payslips · Documents · Profile) and a generalized `<ManagerTriageBanner module=... />` driving all three personal portals.
- **B5.5 (other)** — Replacing the `EmployeeProfile` "Attendance" tab with an inline `EmployeeTrendDrawer`, and deep-linking `Payroll → Runs.tsx` "Open work entries" to `/hr/attendance/roster?from=…&to=…&run_id=…`.
- **B5.1.3** — Adding `SavedViewMenu` + `StatusFilterChips` to `Roster.tsx` for header parity with Today.
- **Reusable `useListHotkeys`** factored from `useApprovalsHotkeys` for use on `TimesheetApprovals.tsx` (J/K nav).

## Verified by
- `bunx vitest run src/test/architecture/attendance-ux.test.ts src/test/architecture/attendance-wave3b.test.ts src/test/architecture/cross-module-ux-parity.test.ts`

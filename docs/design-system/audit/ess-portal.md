# Employee Self-Service Portal — Design System Audit

_Snapshot after Waves A / B / D + the Wave-B tail migration. Every page
under `src/pages/me/*` now consumes the platform `PageHeader` +
`PageBody` primitives and is enforced by
`src/test/architecture/me-uses-design-system.test.ts` (allow-list is
empty — no page may hand-roll its header)._

## Shell

| Surface | Status | File(s) |
| --- | --- | --- |
| Portal chrome (rail + topbar) | Done — structural parity with `WorkspaceShellFrame` + `WorkspaceSidebar`; collapsible icon rail; grouped nav (Operations / Development / Records / Account); shared topbar treatment | `src/components/me/MePortalLayout.tsx` |
| Redundant horizontal sub-nav | Retired | `src/components/me/MeSubNav.tsx` (deleted) |
| Employee-link empty state | Done — `EmployeeLinkRequired` is the single source | `src/components/me/EmployeeLinkRequired.tsx` |

## Pages

Every page in `src/pages/me/*` uses `PageHeader` + `PageBody` from
`@/design-system`. The architecture test enforces this on every file;
the ESLint rule `no-hand-rolled-me-header` flags the retired `<h1>`
sizing in-editor.

Additional per-page primitives already in place:

| Page | Extras |
| --- | --- |
| MyLeave | `ManagerTriageBanner`, `KpiStrip` |
| MyPayslips | `KpiStrip`, `ReportExportButtons` in actions slot |
| MyAttendance | `ManagerTriageBanner` |
| MyTimesheets | `ManagerTriageBanner` |

## Guardrails (ship-blocking)

- **ESLint rule** `eslint-rules/no-hand-rolled-me-header.js` — flags any
  `<h1 className="… text-2xl …">` inside `src/pages/me/*`.
- **Architecture test** `src/test/architecture/me-uses-design-system.test.ts`
  — asserts every `/me/*` page imports `PageHeader` from
  `@/design-system` and does not hand-roll the retired header sizing.
  The allow-list is empty; adding a new entry is a regression.
- **Static test** `src/test/architecture/hr-suite-wave-c.test.ts`
  asserts the MeSubNav retirement.

## Follow-on work (Wave C — interaction-pattern parity)

### KPI parity on list surfaces — done
- [x] `MyLoans` — bespoke stat `<Card>` triplet replaced with `KpiStrip`.
- [x] `MyTimesheets` — 5-tile `KpiStrip` (total / billable / submitted /
      approved / draft) added above the week grid.
- [x] `MyTalent`, `MyTeamTalent` — hand-rolled `text-2xl` KPI grids
      replaced with `KpiStrip`.

### Shared HR status map — done
- [x] `src/components/hr/hrStatusMap.ts` — single `{ status → { tone, label } }`
      resolver returning design-system `StatusBadge` tones.
- [x] `MyPayslips`, `MyLoans` refactored to consume it via the
      design-system `StatusBadge`; bespoke `STATUS_STYLE` / `STATUS_LABEL`
      maps removed. `MyLeave`, `MyShifts`, `MyDocuments` did not
      redefine their own colour palettes and need no refactor beyond
      opting-in when they next surface a status pill.


### Dialog → sheet / route triage — done
- [x] `MyLeave` — `LeaveRequestForm` promoted to routed `/me/leave/new`
      (WorkflowSheet-based; sheet closes back to `/me/leave`).
- [x] `MyOneOnOnes` — `ScheduleDialog` retired; new
      `/me/one-on-ones/new` on `RecordFormShell` is the record-create
      surface.
- [x] `MyLearningPage` — `CourseContentDialog` and `CompleteDialog`
      both moved to `DetailSheet` (+ `FooterActionBar` anchor="sheet").
- [x] `MyShifts` — shift-swap Dialog moved to `DetailSheet`.
- [x] Zero `@/components/ui/dialog` imports remain in `src/pages/me/*`
      (enforced by the arch test below).

### Enforcement additions — done
- [x] `no-hand-rolled-me-header` now also flags any
      `text-2xl font-(semibold|bold)` KPI value block anywhere in
      `src/pages/me/*` — the drift that used to slip past the h1 check.
- [x] `me-uses-design-system.test.ts` extended with two new suites:
      one asserts no page imports `@/components/ui/dialog` (record
      forms must be `RecordFormShell` / `DetailSheet` / `WorkflowSheet`);
      one mirrors the ESLint KPI check statically so CI catches it
      even when the editor doesn't run ESLint.


## Out of scope

- Router migration (`react-router-dom` → TanStack Router).
- Business logic in `/me` hooks — reads/writes unchanged.
- Talent/Learning feature scope — presentation only.
- Entitlement gating, session/auth flows, notifications wiring.

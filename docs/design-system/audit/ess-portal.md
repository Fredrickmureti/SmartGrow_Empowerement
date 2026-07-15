# Employee Self-Service Portal — Design System Audit

_Snapshot after the ESS consistency wave (Wave A shell rebuild + Wave B
priority-page migrations + Wave D guardrails). The portal was materially
drifted from the rest of the platform — zero pages consumed
`@/design-system` primitives, the layout duplicated its own nav rail with
a redundant horizontal sub-nav, and every page hand-rolled its own
`<h1>` and status-badge maps. This audit tracks the remediation._

## Shell

| Surface | Status | File(s) |
| --- | --- | --- |
| Portal chrome (rail + topbar) | Done — structural parity with `WorkspaceShellFrame` + `WorkspaceSidebar`; collapsible icon rail; grouped nav (Operations / Development / Records / Account); shared topbar treatment | `src/components/me/MePortalLayout.tsx` |
| Redundant horizontal sub-nav | Retired — duplicated the left rail | `src/components/me/MeSubNav.tsx` (deleted) |
| Employee-link empty state | Done — `EmployeeLinkRequired` is the single source | `src/components/me/EmployeeLinkRequired.tsx` |

## Pages

| Page | Status | File |
| --- | --- | --- |
| Home | Done — `PageHeader` + `PageBody` | `src/pages/me/MeHome.tsx` |
| Time off | Done — `PageHeader` + `PageBody` + `ManagerTriageBanner` | `src/pages/me/MyLeave.tsx` |
| Payslips | Done — `PageHeader` + `PageBody` + `ReportExportButtons` in actions slot | `src/pages/me/MyPayslips.tsx` |
| Documents | Done — `PageHeader` + `PageBody` | `src/pages/me/MyDocuments.tsx` |
| Attendance | Done — `PageHeader` + `PageBody` | `src/pages/me/MyAttendance.tsx` |
| Loans | Done — `PageHeader` + `PageBody` | `src/pages/me/MyLoans.tsx` |
| Shifts | Done — `PageHeader` + `PageBody` | `src/pages/me/MyShifts.tsx` |
| Onboarding | Done — `PageHeader` + `PageBody` | `src/pages/me/MyOnboarding.tsx` |
| Tax certificates | Pending — hand-rolled header | `src/pages/me/MyTaxCertificates.tsx` |
| Exit clearance | Pending — hand-rolled header | `src/pages/me/MyExitClearance.tsx` |
| Settings | Pending — hand-rolled header | `src/pages/me/MySettings.tsx` |
| Talent (all) | Pending — Talent cluster (Talent, Goals, GoalDetail, Reviews, ReviewDetail, Competencies, DevelopmentPlan, OneOnOnes, OneOnOneDetail, Feedback) | `src/pages/me/MyTalent*.tsx`, `src/pages/me/MyGoal*.tsx`, `src/pages/me/MyReview*.tsx`, `src/pages/me/MyCompetencies.tsx`, `src/pages/me/MyDevelopmentPlan.tsx`, `src/pages/me/MyOneOnOne*.tsx`, `src/pages/me/MyFeedback.tsx` |
| Learning cluster | Pending — Learning, LearningCatalog, LearningPaths, QuizPlayer | `src/pages/me/MyLearning*.tsx`, `src/pages/me/MyQuizPlayerPage.tsx` |
| Team cluster (manager views under /me) | Pending — TeamPage, TeamTalent, TeamLearningPage | `src/pages/me/MyTeam*.tsx` |

## Guardrails (ship-blocking)

- **ESLint rule** `eslint-rules/no-hand-rolled-me-header.js` — flags any
  `<h1 className="… text-2xl …">` inside `src/pages/me/*`. The migration
  target is `<PageHeader />` from `@/design-system`.
- **Architecture test** `src/test/architecture/me-uses-design-system.test.ts`
  — asserts every non-allow-listed `/me/*` page imports `PageHeader` from
  `@/design-system` and does not hand-roll the retired header sizing.
  Allow-list entries are the "Pending" rows above; migrate the page
  before removing its allow-list entry.
- **Static test update**: `src/test/architecture/hr-suite-wave-c.test.ts`
  now asserts the MeSubNav retirement rather than its presence.

## Follow-on work (queued)

### Wave B tail — remaining 20 pages
Mechanical `PageHeader` + `PageBody` swap. Each page ≈ 20-40 LOC diff;
no behaviour change beyond replacing the header block. Order-of-work
follows the priority order in the parent plan (Records → Talent →
Learning → Team clusters).

### Wave C — interaction-pattern parity
Not started. Includes:
- `MyLeave` request-form dialog → routed `/me/leave/new` on
  `RecordFormShell`.
- `MyShifts`, `MyLearningPage`, `MyOneOnOnes` dialog imports → confirm
  which are pure confirms (keep as `AlertDialog`), which are record-shaped
  forms (route them via `RecordFormShell`), which are detail peeks (use
  `DetailSheet`).
- `KpiStrip` on list surfaces (`MyLeave`, `MyTimesheets`, `MyLoans`,
  `MyPayslips`).
- Shared HR status map so `MyPayslips`, `MyLoans`, `MyLeave`, `MyShifts`,
  `MyDocuments` stop redefining their own colour palette per page.
- `ManagerTriageBanner` on `MyTimesheets` (already on `MyLeave` and
  `MyAttendance`).

### Out of scope for this wave
- Router migration (`react-router-dom` → TanStack Router) — the whole
  app is on `react-router-dom`; migrating only `/me` breaks parity.
- Business logic in `/me` hooks — reads/writes unchanged.
- Talent/Learning feature scope — only their presentation.
- Entitlement gating, session/auth flows, notifications wiring —
  behaviour was already correct.
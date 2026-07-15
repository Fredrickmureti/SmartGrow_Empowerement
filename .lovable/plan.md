## Audit of the previous agent's ESS work

I walked every claim in `docs/design-system/audit/ess-portal.md` against the actual source.

**Verified complete (previous agent's claims hold up):**
- Shell rebuild in `src/components/me/MePortalLayout.tsx` (rail + topbar + grouped nav, `MeSubNav` retired).
- All 20 "Pending" pages in the audit **are in fact migrated** to `PageHeader` + `PageBody` from `@/design-system` — including MyTalent, MyGoals, MyReviews, MyCompetencies, MyDevelopmentPlan, MyOneOnOnes(+Detail), MyFeedback, MyLearning* cluster, MyTeam*, MySettings, MyTaxCertificates, MyExitClearance. The Wave B tail is functionally done; only the *bookkeeping* was never updated.
- KPI strips on MyLeave and MyPayslips (last agent's final message) — confirmed.
- `ManagerTriageBanner` on MyTimesheets — **already present** at `src/pages/timesheets/MyTimesheets.tsx:150`, contrary to the audit doc which lists it as pending.

**Confirmed still outstanding (Wave C):**
1. `src/test/architecture/me-uses-design-system.test.ts` allowlist and `docs/design-system/audit/ess-portal.md` "Pending" table are stale — 20 pages listed as pending are actually migrated. Guardrail is currently useless (every migrated page is exempt from the check).
2. `MyLoans` KPI section is hand-rolled `<Card>` triplets (`src/pages/me/MyLoans.tsx:99-130`), not the shared `KpiStrip`.
3. `MyTimesheets` has no `KpiStrip` (only the manager banner).
4. `MyLeave` still opens `LeaveRequestForm` as a `Dialog` (`src/pages/me/MyLeave.tsx:180`). Platform standard for record-shaped forms is `RecordFormShell` behind a route (`/me/leave/new`).
5. `MyShifts`, `MyLearningPage`, `MyOneOnOnes` still import from `@/components/ui/dialog` for what look like record-form / detail interactions — need to be triaged: confirm → `AlertDialog`, form → routed `RecordFormShell`, peek → `DetailSheet`.
6. No shared HR status map — `MyPayslips`, `MyLoans`, `MyLeave`, `MyShifts`, `MyDocuments` each redefine their own tone/palette maps for status badges.
7. `MyTalent` (line 140) and `MyTeamTalent` (line 195) hand-roll KPI cards with `text-2xl` — not caught by the lint rule because they aren't `<h1>`, but they're the same drift the lint targets. Should adopt shared KPI presentation.

**Out of scope (as declared, leaving alone):** router migration, business-logic in `/me` hooks, feature scope for Talent/Learning, entitlements/session.

## Plan

### Phase 1 — Close the bookkeeping gap (fast, high-signal)
- Empty `MIGRATION_TODO` in `src/test/architecture/me-uses-design-system.test.ts` so the guardrail actually enforces PageHeader on every `/me/*` page going forward. If the test then fails for any file, that's a real regression I'll fix in the same phase.
- Update `docs/design-system/audit/ess-portal.md`:
  - Move the 20 rows to Done.
  - Mark `MyTimesheets` ManagerTriageBanner as Done.
  - Rewrite the "Follow-on work" section to reflect the actual remaining items below.

### Phase 2 — KPI parity on list surfaces
- Replace `MyLoans` bespoke KPI cards with `KpiStrip` from `@/components/hr/KpiStrip` (the same primitive already used on `MyLeave` / `MyPayslips`).
- Add a `KpiStrip` to `src/pages/timesheets/MyTimesheets.tsx` scoped to self-service mode (via `useSelfService`) — hours submitted / approved / draft this period.
- Replace the hand-rolled KPI grids in `MyTalent` and `MyTeamTalent` with `KpiStrip` so they stop drifting.

### Phase 3 — Shared HR status map
- Create `src/components/hr/hrStatusMap.ts`: a single `{ status → { tone, label } }` map for HR record statuses (approved/pending/rejected/draft/paid/cancelled/…) returning `StatusBadge` tones (`neutral/info/success/warning/danger/accent`).
- Refactor `MyPayslips`, `MyLoans`, `MyLeave`, `MyShifts`, `MyDocuments` to consume it via the design-system `StatusBadge`. No behavioural change.

### Phase 4 — Interaction-pattern parity (dialog → sheet/route)
- `MyLeave`: promote the request flow to a route `/me/leave/new` (react-router-dom, matching current routing) mounted on `RecordFormShell`. Keep `LeaveRequestForm` as the field body; retire the Dialog wrapper on `MyLeave`.
- `MyShifts`, `MyLearningPage`, `MyOneOnOnes`:
  - `MyOneOnOnes` `ScheduleDialog` → routed `/me/one-on-ones/new` on `RecordFormShell` (record-shaped).
  - `MyLearningPage` `CompleteDialog` → keep as `AlertDialog` (pure confirm); `CourseContentDialog` → `DetailSheet` (detail peek).
  - `MyShifts` dialogs → triage per the same rubric (confirms stay `AlertDialog`, detail peeks → `DetailSheet`).

### Phase 5 — Enforcement additions
- Extend `eslint-rules/no-hand-rolled-me-header.js` (or a sibling rule) to also flag `text-2xl font-semibold` / `text-2xl font-bold` blocks used as KPI values inside `/me/*` — catches the MyTalent/MyTeamTalent-style drift the current rule misses.
- Add an assertion to `me-uses-design-system.test.ts` that no `/me/*` page imports `@/components/ui/dialog` for record-shaped forms (allowlist only pure confirmations).

### Technical notes
- All changes stay on `react-router-dom` — no TanStack Router migration.
- No changes to `/me` data hooks or business logic.
- New shared modules live in the platform's existing homes: `src/components/hr/` for the status map, existing `KpiStrip`, existing `RecordFormShell`.
- Every file touched will be verified against `tsgo` and the arch tests before I close the phase.

### Deliverables per phase
- Phase 1: allowlist emptied, audit doc rewritten, `hr-suite-wave-c.test.ts` still green.
- Phase 2: KpiStrip on MyLoans, MyTimesheets, MyTalent, MyTeamTalent.
- Phase 3: `hrStatusMap.ts` + 5 pages refactored.
- Phase 4: 2 new routes (`/me/leave/new`, `/me/one-on-ones/new`), 3 files with dialog imports removed or replaced.
- Phase 5: 2 guardrail extensions.

Say the word and I'll execute phases 1→5 in order.

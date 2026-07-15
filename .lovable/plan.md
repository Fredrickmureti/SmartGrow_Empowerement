## Goal
Redesign the empty states on `/me/shifts` (My Shifts) so the page feels intentional and inviting when there's nothing scheduled, instead of two plain "No upcoming shifts." / "No swap requests." lines.

## Scope
Presentation-only change in `src/pages/me/MyShifts.tsx`. No changes to hooks, data, routing, or business logic.

## Changes

### 1. Upcoming shifts empty state
Replace the muted `<p>No upcoming shifts.</p>` with the design-system `EmptyState` primitive (`@/design-system`):
- Icon: `CalendarClock` (lucide)
- Title: "No shifts scheduled"
- Description: "You have no assigned shifts in the next 60 days. Your roster will appear here once your manager publishes it."
- No action button (nothing for the employee to do here).

### 2. Swap requests empty state
Replace `<p>No swap requests.</p>` with `EmptyState`:
- Icon: `ArrowLeftRight`
- Title: "No swap requests"
- Description: "Swap requests you send or receive will show up here with their approval status."

### 3. Light polish around them
- Give both cards a consistent min-height so the empty states breathe (e.g. `min-h-[220px]` on `CardContent`, centered).
- Keep the existing `PageHeader` / `PageBody` / `Card` chrome — this is a design-system audit-clean page and we shouldn't rework the header per the `me-uses-design-system` guardrail.

## Non-goals
- No new empty-state for "Recent shifts (last 14 days)" — that card is already conditionally hidden when empty.
- No changes to the swap-request `DetailSheet`, hooks, or any data flow.
- No new routes, no changes to `MePortalLayout`.

## Files touched
- `src/pages/me/MyShifts.tsx` (only).

## Verification
- Visual: preview `/me/shifts` for an employee with no shifts — both empty states render with icon + title + description.
- Guardrails: `no-hand-rolled-me-header` (unchanged header) and `me-uses-design-system.test.ts` remain green (no new `text-2xl` KPI blocks, no `@/components/ui/dialog` imports introduced).

# Cycle Count Schedules — reconnect the page to the inventory foundation

You were right: this page is not wired to the same rules as the rest of Inventory. Three concrete defects confirmed against the live database and the code.

## What is actually wrong

1. **The warehouse picker is unfiltered.** `CycleCountSchedules.tsx` runs its own private `warehouses` query with no filters beyond org + business. Every other inventory surface (the shared `useWarehouses` hook, the warehouse scope gate, stock/transfers) excludes `is_in_transit = true`, filters `is_active = true`, and scopes to the current branch. Your tenant has exactly two warehouse rows — "Headquarters Warehouse" and "In-Transit" (`is_in_transit = true`) — which is why the pseudo-warehouse shows up here and nowhere else. In-Transit is a bookkeeping bucket; you can never physically count it.

2. **The schedules list is scoped to the organization only.** The list query filters `organization_id` but not `business_id` or branch, so in a multi-business org the page would show schedules that belong to another business, while the create form stamps the current business. That mismatch is the second half of the "disconnected" feeling.

3. **Nothing runs the schedules on a timer.** `generate_due_cycle_counts()` exists in the database and the page can invoke it manually, but there is no scheduled job calling it — verified: no cron entry references it. So `next_run_at` passes and no count is ever generated unless somebody opens this page and clicks the button. The schedule is decorative today.

## The fix

**A. Use the canonical warehouse source.**
Delete the page's private warehouse query and consume the shared warehouse hook, so the picker inherits the platform rules for free: in-transit excluded, inactive excluded, branch scoped, same ordering. If no warehouse is available, the create action explains that instead of silently offering nothing.

**B. Scope the schedules list correctly.**
Add the business filter (and branch alignment via the warehouse) to the list query and its query key, so the list and the create form always agree on which business you are looking at.

**C. Guard existing rows.**
Any schedule already pointing at the In-Transit warehouse is invalid. The page will flag such a row inline ("This schedule targets an in-transit bucket and cannot be counted — repoint it") rather than hiding it, so nothing disappears without explanation.

**D. Make the rotation actually run.**
Register a scheduled job that calls `generate_due_cycle_counts()` (hourly; the function itself only picks up rows whose `next_run_at` has passed). Keep the manual run control as the operator override. This is what turns the page from configuration-only into a working rotation.

**E. Lock it in.**
Add an architecture test asserting that no inventory page queries the `warehouses` table directly for an operational picker — the shared hook is the only allowed seam. That is the rule that was broken here, and this stops it recurring on the next screen.

## Technical notes

- Files: `src/pages/inventory/CycleCountSchedules.tsx` (picker + list scope + inline guard), a new arch test under `src/__tests__/`, one migration for the cron registration.
- No schema change to `cycle_count_schedules`.
- Existing schedule rows are untouched; only how they are read and displayed changes.
- Scope stays inside Inventory; no other app's warehouse pickers are modified.

## Out of scope

The wider question of whether other modules also hand-roll warehouse queries — the arch test in step E will surface those, and we can address the list in a follow-up rather than widening this change.

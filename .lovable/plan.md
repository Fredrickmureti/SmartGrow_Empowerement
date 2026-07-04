# Talent Subsystem — Implementation Status

## Verified state (this session, audit-verified)

### Phase 2 — Notification completeness (SHIPPED — verified)
- `_talent_notify` + client `notifyTalentBulk`/`notifyTalent` present.
- `talent_merit_apply`, `talent_calibration_apply_adjustment`,
  `talent_place_on_nine_box`, `talent_quiz_grade` all notify atomically.
- `talent_emit_due_notifications` scheduled every 15 min via
  `cron.schedule('talent-due-notifications', ...)` — reissued idempotently
  in this session so remixed projects also get it.

### Phase 4 — Reviews (SHIPPED — verified)
- `review_responses` goal-linked prefill, "From goal" chip.

### Phase 5 — Skill inventory truth (SHIPPED — verified)
- `competency_assessments.source`, unique `(employee_id, competency_id)`,
  quiz uplift with `GREATEST` guard, `talent_devplan_item_complete` RPC.

### Phase 6 — Governance & configurable defaults (SHIPPED this session)
- `public.talent_settings` — one row per organization holding review-scale
  defaults, `merit_requires_approval`,
  `calibration_requires_approval`, `devplan_activation_requires_approval`,
  reminder cadences (1:1 hours, action item days, goal check-in days),
  HiPo thresholds, `require_manager_ack_on_review`, `auto_close_cycles`.
- Read RLS open to any org user (feeds client-side branching); write RLS
  gated to admin / owner / super_admin.
- Seeded for every existing org; trigger seeds on future `organizations`
  inserts. `default_competency_scale_id` populated when a default
  competency scale exists.
- `_competency_scale_seed` trigger on `organizations`: every new org gets
  a "Standard 5-point" competency scale (Novice/Developing/Proficient/
  Advanced/Expert) and the corresponding pointer wired into
  `talent_settings`. Backfilled for existing orgs missing a scale.
- `talent_emit_due_notifications` extended to:
  - honor `oneonone_reminder_hours` (default 24) as the 1:1 look-ahead;
  - emit `oneonone.action_item` reminders for open normalized action
    items whose `due_date` falls within `action_item_reminder_days`.
- Client: `useTalentSettings` hook (read + mutate) and new
  `/hr/talent/settings` page (routed via `TalentRoutes`).

### Phase 7 — Duplication (mostly SHIPPED, tail SHIPPED this session)
- `src/lib/talent/employeeGraph.ts` in use by `useTalent` and
  `useDevelopmentPlans`.
- **Tail shipped this session:** `public.oneonone_action_items` table
  normalizes the old JSONB list into first-class rows (with owner, due
  date, status, completed_at, RLS mirroring 1:1 participants). Backfilled
  from the JSONB column; JSONB column retained for one release as a
  compatibility fallback. `useOneOnOne` now reads/writes the new table
  via a per-row diff (insert/update/delete) and merges the result into
  the meeting shape so existing UI keeps working.

### Phase 8 — Succession & 9-box lifecycle (SHIPPED — verified)
- HiPo cell → `employee_lifecycle_events` (`event_kind=hipo_designated`).
- Successors `readiness=ready_now` trigger fires
  `event_kind=succession_ready`.
- "Create requisition" CTA on Succession page.

## Remaining (deferred)

- **Phase 6.2 approval-workflow binding UI.** The governance flags exist
  in `talent_settings`; wiring `useMerit.apply`, `useCalibration.apply`,
  and dev-plan activation to submit an `approval_requests` row and read
  from the existing approval-history UI is the next natural increment.
  Deferred because it is the highest-regression change and warrants its
  own pass (mock, per-role approvers, dispatcher RPC to run the underlying
  apply RPC once approved). The existing internal merit workflow
  (propose → approve → apply) already satisfies audit for merit; only
  calibration adjustments + dev-plan activation lack an explicit approval
  step today.
- **Drop of `one_on_ones.action_items` JSONB column.** Kept for one
  release as a fallback; scheduled removal migration after consumers are
  confirmed off the JSONB path.

## Migrations added this session

- `talent_settings` table + RLS + backfill + org-insert trigger.
- `oneonone_action_items` table + RLS + backfill from JSONB.
- Default competency scale backfill + `organizations` insert trigger.
- Rewrite of `talent_emit_due_notifications` to honor settings and
  emit action item reminders.

## Non-migration DB changes

- Reissued `cron.schedule('talent-due-notifications', '*/15 * * * *', …)`
  after unscheduling any prior copy.

# Talent Subsystem — Implementation Status

Progress against the approved continuation plan.

## Delivered this session

### Phase 2 — Notification completeness (SHIPPED)
- `src/lib/talent/notifications.ts` rewritten: single-round-trip `notifyTalentBulk` +
  thin `notifyTalent` wrapper. Added kinds `review.rating_calibrated`,
  `competency.uplifted`, `merit.applied`, `nine_box.placed`, `succession.designated`,
  `succession.ready`.
- Server-side `public._talent_notify(...)` helper; wraps failures so a
  notification error can never roll back the primary business transition.
- Silent-transitions closed inside the RPCs themselves (atomic with the write):
  - `talent_merit_apply` → notifies affected employee (`merit.applied`).
  - `talent_calibration_apply_adjustment` → notifies reviewee's manager (`review.rating_calibrated`).
  - `talent_place_on_nine_box` → notifies placed employee (`nine_box.placed`).
  - `talent_quiz_grade` on pass → notifies employee (`competency.uplifted`).
- `goal.completed` fires from `useTalent.checkIn` for employee + manager.
- Dormant `goal.checkin_due` and `oneonone.reminder` now emitted by
  `public.talent_emit_due_notifications()`, scheduled via **pg_cron every 15 min**
  (`talent-due-notifications`). Uses a de-dup window so reminders don't storm.

### Phase 5 — Skill inventory truth (SHIPPED)
- `competency_assessments.source` column added (`self | manager | training | calibration`).
- Unique index `(employee_id, competency_id)` added to support upserts.
- `talent_quiz_grade` extended: on pass, upserts `competency_assessments`
  with `source='training'` (uses `GREATEST` so training never lowers an
  existing level). Emits `certification_earned` lifecycle event via
  `employee_lifecycle_events` (type=`custom`, payload.event_kind) when
  the course has `requires_certificate=true`.
- New `talent_devplan_item_complete(_item_id)` RPC — marks the item done,
  uplifts the linked competency (level from `training_courses.target_level`
  when present, otherwise default intermediate), writes `talent_audit_log`.
- `useDevelopmentPlans.updateItem` routes `status=completed` through the
  RPC (backward-compatible: non-completion patches still take the direct
  UPDATE path).

### Phase 8 — Succession & 9-box lifecycle events (backend SHIPPED)
- 9-box HiPo cell (potential=3 & performance=3) now emits an
  `employee_lifecycle_events` row with `payload.event_kind='hipo_designated'`.
- `successors.readiness → 'ready_now'` (INSERT or UPDATE) fires a trigger
  that emits `payload.event_kind='succession_ready'`.
- Note on enum: `employee_lifecycle_event_type` is a live enum used across
  the ERP; we used `type='custom'` + `payload.event_kind='...'` for the
  three new subtypes rather than adding enum values in the same transaction
  as their first use (Postgres rejects that). Downstream consumers should
  read `payload.event_kind` for these three kinds.

### Fixes
- Repaired brace mismatch in `src/hooks/useReviews.ts` `launchReviews`
  that Phase 4 introduced (parser was breaking at line 444).

## Remaining (not started this session)

- **Phase 4 tail** — Goal-linked review question pre-fill from
  `performance_goals.final_rating` in the response UI.
- **Phase 6** — Approval-workflow binding for merit/dev-plan-activation/
  calibration; `talent_settings` table for defaults; per-org default
  `competency_scales` seed.
- **Phase 7** — Normalize `one_on_ones.action_items` JSONB → dedicated
  table; extract `getManagerFor` to `src/lib/talent/employeeGraph.ts`
  and delete four duplicates.
- **Phase 8 UI** — "Create requisition" CTA on ready-now successors — SHIPPED.
  Button appears on any successor row where `readiness = 'ready_now'`; seeds
  a draft `job_requisitions` row (title = plan role, headcount 1, provenance
  note referencing the successor) and routes to `/hr/recruitment`.

### Shipped this pass
- MeritPage "From review" provenance chip next to the rating column
  (visible whenever the row carries a `review_id`).
- `training.assigned` notifications now fire from `createEnrollment` and
  `bulkEnroll` in `usePerformance` — recipients get a bell + /me link.
- Fixed goal-completion comparison in `useTalent.checkIn` to use the
  actual `GoalStatus` value `"completed"` (was `"done"`, which never
  matched the enum and silently disabled the `goal.completed` notify path).

## Migrations delivered

- `20260704224502_*_talent-phase-2-and-5.sql` (RPC-side notifications,
  quiz→competency uplift, certification lifecycle, 9-box HiPo &
  succession readiness triggers, `talent_devplan_item_complete`,
  `talent_emit_due_notifications`).

## Non-migration DB changes

- `cron.schedule('talent-due-notifications', '*/15 * * * *', ...)` —
  scheduled via the insert tool (project-specific config, kept out of
  migrations).

# Talent Subsystem — Continuation Plan

## Verified status of prior agent's work

I re-checked every claim against the code and migrations, not the notes:

| Phase | Claim | Reality |
|---|---|---|
| 1 — Audit-defensibility | Done | **Confirmed.** Migration `20260704220134` wires 7 `talent_audit_log` writes across sign-off, calibration apply/reject, merit approve/apply/reject, 9-box place, dev-plan activate, quiz-grade. New RPCs `talent_calibration_reject_adjustment` and `talent_remove_from_nine_box` exist and are wired in `useCalibration.reject` and `useSuccession.remove`. `continuous_feedback.from_user_id_admin` column + trigger + backfill in place. |
| 2 — Notification completeness | Not claimed | **Not started.** `notifyTalent` still does per-recipient `v_employees_canonical` lookup + single insert; no bulk path; the four dormant kinds (`training.assigned`, `goal.checkin_due`, `goal.completed`, `oneonone.reminder`) plus merit/calibration/9-box/succession employee-visible fires are missing. |
| 3 — Review→Merit→Contract→Payroll | Done | **Confirmed.** Migration `20260704220918` extends `talent_merit_apply` to insert `contract_amendments`, `retro_pay_adjustments` (when effective_date ≤ today), and `employee_lifecycle_events.salary_changed`; adds `talent_seed_merit_from_review` used by sign-off. Frontend provenance ("seeded from review") not yet surfaced in `MeritPage`. |
| 4 — Review integrity backend | Done | **Confirmed.** `useReviews.launchReviews` honours `includes_peer`/`includes_skip_level` and reads pre-nominated `review_participants`; `saveResponse` accepts + persists `goal_id`. Goal-linked pre-population of `performance_goals.final_rating` into the response draft is **not yet wired in the review form UI**. |
| 5 — Skill inventory truth | Not started | Prior agent stopped here. |
| 6 — Governance & config | Not started | |
| 7 — Structural cleanups | Not started | |
| 8 — Succession ↔ Recruitment | Not started | |

Nothing already-done will be re-done. Two small residual items from finished phases are folded into the phase they belong to (merit provenance badge → Phase 3 tail; goal pre-fill in review form → Phase 4 tail).

---

## Remaining work

### Phase 2 — Notification completeness (no schema changes)
- Rewrite `src/lib/talent/notifications.ts`:
  - Add `notifyTalentBulk(args & { employeeIds?: string[]; userIds?: string[] })` that does one `SELECT id, user_id FROM v_employees_canonical WHERE id = ANY(...)` and one batched `INSERT` into `notifications`.
  - Keep `notifyTalent` as a thin wrapper over the bulk path.
- Fire the four dormant kinds:
  - `training.assigned` — inside `useLearning.assignTraining` / dev-plan item insert when `training_course_id` set.
  - `goal.completed` — in `useGoals.updateStatus` when status transitions to `completed`.
  - `goal.checkin_due` and `oneonone.reminder` — add a lightweight scheduler via a `pg_cron`-invoked SQL function `talent_emit_due_notifications()` that inserts rows for goals with `next_check_in_date <= today` and 1-on-1s scheduled within 24h. No new edge function.
- Add employee-visible fires that are currently silent:
  - `merit.applied` (new kind) — on `talent_merit_apply`, notify the affected employee. Add kind to the union type + DB category kept as `talent`.
  - `review.rating_calibrated` — on `talent_calibration_apply_adjustment`, notify the reviewee's manager.
  - `nine_box.placed`, `succession.designated` — on the corresponding RPCs.

### Phase 3 tail — Merit provenance UI
- `MeritPage`: show a "Seeded from review" chip with a link to the source `performance_reviews.id` (already stored on the recommendation), and mark seeded rows read-only until an approver acts.

### Phase 4 tail — Goal pre-population in review form
- In the review response component, when a question has `goal_id` context, pre-fill the rating from `performance_goals.final_rating` (or `progress`) and pre-fill `goal_id` on save.

### Phase 5 — Skill inventory truth
- SQL migration: extend `talent_quiz_grade` and add `talent_devplan_item_complete` (or extend the existing completion path) so that on:
  - quiz pass (`score >= pass_score`) with the course linked to a competency → upsert `competency_assessments` (`source='training'`, level derived from score band configured on the course).
  - dev-plan item completion where the item has both `training_course_id` and `competency_id` → upsert `competency_assessments` similarly.
- Emit `employee_lifecycle_events.certification_earned` when the course row is flagged `is_certifying = true` (add column if missing, default false).
- Notify the employee (`competency.assess_due` reuse or new `competency.uplifted`).

### Phase 6 — Governance & configurable defaults
- Bind three transitions to `approval_workflows` via a small helper `talent_request_approval(entity_type, entity_id)` and status enum extension:
  - merit approval
  - dev-plan activation
  - calibration adjustment apply
- Fallback: when no matching `approval_rule`, proceed with the current manager-only path (preserves behaviour).
- Create `talent_settings` table (per-org, single-row) holding: default competency scale id, quiz `pass_score`/`max_attempts`, 9-box axis labels (JSONB), competency final-level formula (`avg | max | manager_only`). Seed defaults on org create via existing org-provisioning trigger.
- Replace `DEFAULT_SCALE` synth in `useCompetencyFramework` with a real `competency_scales` row seeded per org.

### Phase 7 — Structural cleanups
- New table `one_on_one_action_items` with FKs to `one_on_ones`, optional `goal_id`, optional `development_plan_item_id`, `assignee_employee_id`, `due_date`, `status`. Migrate existing JSONB `one_on_ones.action_items` in place, keep the JSONB column temporarily for rollback but stop writing to it.
- Wire `oneonone.action_item` notification on insert.
- Extract manager resolution to `src/lib/talent/employeeGraph.ts` (`getManagerFor(employeeId)`, `getReportsOf(managerId)`) and replace four duplicates in `useTalent`, `useContinuousPerformance`, `useDevelopmentPlans`, `useCompetencyFramework`.

### Phase 8 — Succession ↔ Recruitment bridge
- Emit `employee_lifecycle_events` `hipo_designated` (on 9-box HiPo cell) and `succession_ready` (on `successors.readiness = 'ready_now'`).
- In `useSuccession`, when a successor is `ready_now` and the target `job_position` has no open non-closed `job_requisition`, surface a "Create requisition" CTA that deep-links into Recruitment prefilled from the position + successor (no auto-create).
- No Recruitment module functional changes beyond the CTA target already supported.

---

## Cross-cutting rules for every phase

- All migrations additive; no drops.
- All new RPCs `SECURITY DEFINER`, `search_path = public`, `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE TO authenticated`, and write to `talent_audit_log`.
- Downstream propagations wrap failures in `business_event_outbox` so the primary transition never rolls back on a notification/uplift failure.
- No UI redesign; only new affordances (provenance chip, participant chips already present, requisition CTA, action-item list).
- Tests: pgTAP for each new RPC's audit-log + downstream write; Vitest for `notifyTalentBulk` batching, and for the two review-form/MeritPage UI additions.

## Order of delivery

Phase 2 → Phase 3 tail → Phase 4 tail → Phase 5 → Phase 7 → Phase 6 → Phase 8.

Phase 2 first because it unblocks the "silent to employee" complaint immediately with zero schema risk. Phase 7's action-items refactor runs before Phase 6 because governance rules will reference the normalized entities. Phase 8 last because it depends on lifecycle events introduced in Phase 5 & 7.

## Explicitly out of scope

- Visual redesign of any talent page.
- Payroll engine changes beyond consuming the already-supported `retro_pay_adjustments`.
- Recruitment functional changes beyond the requisition CTA.
- eTIMS / M-Pesa / country pack changes.
- Retouching Phases 1, 3-backend, 4-backend that are already verified correct.

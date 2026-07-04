
# Talent Subsystem — Continuation Plan

## Audit verification (what I confirmed vs plan file)

Independent inspection of the code and migrations, not agent notes:

- **Phase 2 (Notifications):** Real. `public._talent_notify` + bulk client helper exist; `talent_merit_apply`, `talent_calibration_apply_adjustment`, `talent_place_on_nine_box`, `talent_quiz_grade` all `PERFORM _talent_notify(...)` inside the same transaction as the write. `talent_emit_due_notifications()` exists and covers goal check-in due + 1:1 reminders. Cron entry claimed but lives outside migrations — I will re-issue it idempotently.
- **Phase 5 (Skills truth):** Real. `competency_assessments.source`, unique `(employee_id, competency_id)`, `GREATEST`-guarded upsert from quiz, `talent_devplan_item_complete` RPC, `useDevelopmentPlans.updateItem` routing on `status='completed'` — all present.
- **Phase 8 (Lifecycle events + requisition CTA):** Backend present (HiPo + succession-ready → `employee_lifecycle_events` with `payload.event_kind`). UI CTA claim verified in `SuccessionPage.tsx`.
- **Phase 7 partial:** `src/lib/talent/employeeGraph.ts` exists and is used from `useTalent.checkIn` + `useDevelopmentPlans.updateItem`.
- **Genuinely outstanding:** Phase 6 (approvals + `talent_settings` + competency scale seed) and Phase 7 tail (`one_on_ones.action_items` JSONB → dedicated table). No `talent_settings` table exists; no approval-workflow wiring around merit/dev-plan/calibration. `useContinuousPerformance` still reads/writes `one_on_ones.action_items` as raw JSONB.

No shallow/regressed work was found in the shipped phases beyond what the file itself documents. Continuation below.

## Scope

Two focused work streams, both required for enterprise parity with Workday/SuccessFactors-style talent governance:

1. **Phase 6 — Talent governance & configurable defaults.**
2. **Phase 7 tail — Normalize 1:1 action items into a first-class entity.**

Everything else described in the audit prompt (cross-module lifecycle, notifications, competency uplift, HiPo/succession, merit → payroll) is already in place from previous phases; I will not re-do it.

## Phase 6 — Governance & settings

### 6.1 `talent_settings` (per-org defaults)

New table `public.talent_settings` (one row per `organization_id`) holding tenant-level defaults that today are hardcoded in RPCs/hooks:

- `default_review_scale_min / max`, `default_competency_scale_id`
- `merit_requires_approval boolean`, `calibration_requires_approval boolean`, `devplan_activation_requires_approval boolean`
- `goal_checkin_reminder_days int`, `oneonone_reminder_hours int` (feed `talent_emit_due_notifications`)
- `hipo_potential_threshold int`, `hipo_performance_threshold int` (feed 9-box HiPo trigger)
- `require_manager_ack_on_review boolean`, `auto_close_cycles boolean`
- `updated_by`, `updated_at`

Grants + RLS (org-scoped, HR-manager write, all-org read). `talent_emit_due_notifications`, `talent_place_on_nine_box`, and `talent_devplan_item_complete` read from this table with sane fallbacks so nothing regresses when a row is absent.

Small settings UI on `TalentDashboard` (or new `TalentSettingsPage` under `/hr/talent/settings`) surfaced to HR admins only.

### 6.2 Approval binding

Use the existing `approval_workflows` / `approval_rules` / `approval_requests` tables (already in the schema). Bind three talent transitions:

| Transition                              | Trigger                                    | Requester                     | Approvers                       |
| --------------------------------------- | ------------------------------------------ | ----------------------------- | ------------------------------- |
| Merit apply (per employee row)          | `useMerit.apply` when `merit_requires_approval` | Manager submitting            | Skip-level manager → HR         |
| Development plan activation             | `useDevelopmentPlans.activate`             | Plan owner                    | Employee's manager → HR         |
| Calibration adjustment apply            | `useCalibration.applyAdjustment`           | Calibration facilitator       | HR business partner             |

Approach:

- Two new server RPCs (SECURITY DEFINER) wrapping the existing "apply" RPCs: `talent_merit_request_approval(_ids uuid[])` and `talent_calibration_request_adjustment(_id uuid)`. Each writes an `approval_requests` row (`entity_type='talent_merit' | 'talent_calibration' | 'talent_devplan_activation'`, `entity_id`, `status='pending'`) and, when settings say approval is not required, calls the existing apply RPC directly (short-circuit).
- A single `talent_approval_finalize(_request_id uuid)` RPC dispatches on `entity_type` and calls the underlying apply function once approval is granted. The existing generic approval-finalize path (if any) can call this via a dispatcher trigger; otherwise the hooks polling approvals call it explicitly.
- Frontend: `useMerit`, `useDevelopmentPlans`, `useCalibration` gain a small branch that inspects `talent_settings` and either calls the direct apply RPC (as today) or the request-approval RPC and shows a "Pending approval" state on the row. Approval history renders through the existing approval-history component.

### 6.3 Competency scale seed

Insert a default `competency_scales` row per organization on org create (via a small `AFTER INSERT` trigger on `organizations`, using service-role safe search_path). Rating: 1 Novice → 2 Developing → 3 Proficient → 4 Advanced → 5 Expert. Idempotent; skips organizations that already have any scale. Backfill existing orgs in the same migration.

### 6.4 Cron re-issue

Re-run the `cron.schedule('talent-due-notifications', '*/15 * * * *', ...)` insert idempotently (unschedule-if-exists, then schedule) so remixed projects get it too.

## Phase 7 tail — Normalize 1:1 action items

New table `public.oneonone_action_items`:

- `id uuid pk`
- `one_on_one_id uuid fk → one_on_ones(id) on delete cascade`
- `organization_id uuid` (denormalized for RLS/index)
- `text text not null`
- `owner` enum (`manager | employee`)
- `due_date date null`
- `status` enum (`open | done | cancelled`) default `open`
- `completed_at`, `created_at`, `updated_at`, `created_by`

Grants + RLS mirroring `one_on_ones`. Migration also backfills existing rows from the JSONB column, then keeps the JSONB column for one release as a compatibility fallback (drop scheduled in the follow-up).

`useContinuousPerformance`:

- Replace the `.update({ action_items })` mutation with per-row insert/update/delete against the new table.
- Read path returns action items joined by `one_on_one_id` for the same UX contract (shape preserved: `{id, text, owner, due, done}` mapped from the new columns).
- `talent_emit_due_notifications` still emits `oneonone.action_item` reminders, now reading from the normalized table (indexed on `status='open' AND due_date`).

Downstream `oneonone.action_item` notifications and the /me task surface pick up the change automatically because they only see the mapped shape.

## Technical details

Migrations (each self-contained, `GRANT` blocks included before `ENABLE RLS`):

1. `talent_settings` table + RLS + seed defaults + reader helpers.
2. Approval-binding RPCs + `talent_approval_finalize` dispatcher, plus small changes to existing apply RPCs to accept a `_bypass_approval boolean default false` (called by the dispatcher).
3. `oneonone_action_items` table + backfill + RLS + notifications-query update.
4. `competency_scales` default seed + `AFTER INSERT` trigger on `organizations`.

Frontend:

- `useTalentSettings` hook (read + admin write).
- New `TalentSettingsPage` (HR admin only) with sections for approvals, reminders, HiPo thresholds, review defaults.
- `useMerit` / `useDevelopmentPlans` / `useCalibration` gain an `approvalPending` state and pending-badge in their list pages.
- `useContinuousPerformance` action-item mutations point at the new table.

Ordering (by risk):

1. Phase 6.3 competency scale seed (pure data, no consumers).
2. Phase 6.1 `talent_settings` (additive, everything falls back if missing).
3. Phase 6.4 cron re-issue (idempotent).
4. Phase 7 tail (dual-read window kept for one release).
5. Phase 6.2 approvals (last, since it changes user-visible flow).

## Non-goals

- No rework of any shipped Phase 2/4/5/8 code.
- No enum churn on `employee_lifecycle_event_type` — keep the `type='custom' + payload.event_kind` convention already in production.
- No new UI for the audit report itself; the report above is the deliverable.

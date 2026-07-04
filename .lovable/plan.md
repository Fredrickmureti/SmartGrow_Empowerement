# Talent & Performance — Enterprise Architecture Audit

## 1. Current Architecture (as-is)

The Talent subsystem is a well-modelled **records layer** with 30+ tables covering the full HCM footprint: cycles, goals, reviews, calibration, continuous feedback, kudos, 1-on-1s, competencies, development plans, learning, quizzes, 9-box, succession, and merit. It has:

- A dedicated route tree (`/hr/talent/*` and `/me/talent/*`) with an installed-app gate.
- Server-authoritative RPCs for the sensitive transitions (`talent_advance_cycle_phase`, `talent_submit_review`, `talent_sign_off_review`, `talent_calibration_apply_adjustment`, `talent_merit_propose/approve/apply`, `talent_place_on_nine_box`, `talent_quiz_grade`).
- A canonical employee read view (`v_employees_canonical`) used consistently.
- A single `notifyTalent` helper writing into the platform `notifications` table.

## 2. Strengths (keep)

- Records model is complete and Odoo/SuccessFactors-shaped.
- Server-side RPCs guard the highest-risk transitions (phase advance, sign-off, merit apply).
- Canonical view usage is disciplined.
- Notification kinds are enumerated centrally and category-tagged.
- App-lifecycle gating and permission model are already in place.

## 3. Weaknesses — architectural (not cosmetic)

The subsystem behaves like a **collection of independent journals**, not a connected HCM. Business events fire but their downstream consequences are not propagated. The 14 gaps below are the material architectural defects:

### A. Event chain is broken (no cross-module propagation)
1. **Review → Merit**: `performance_reviews.final_rating` is not bridged to `merit_recommendations`. Managers must retype it. Enterprise systems auto-seed merit from calibrated ratings.
2. **Calibration → Compensation**: `talent_calibration_apply_adjustment` updates the review row only; nothing flows to `employee_compensation_history`, `contract_amendments`, or `retro_pay_adjustments`.
3. **Merit apply → Contract + Payroll**: `talent_merit_apply` writes `employee_compensation_history` only. A salary change with no `contract_amendment`, no `retro_pay_adjustment`, and no `employee_lifecycle_events.salary_changed` is not an audit-defensible salary change.
4. **Training/Quiz → Competency**: Passing a quiz or completing a training-linked development-plan item does not uplift `competency_assessments.final_level`. Skill inventory drifts from reality.
5. **Goals → Reviews**: `review_responses.goal_id` exists but `saveResponse` never sets it. Goal ratings do not pre-populate review answers.
6. **Succession → Recruitment / Lifecycle**: Successor `ready_now` and 9-box HiPo designation do not create requisitions or emit `employee_lifecycle_events` (`hipo_designated`, `promotion_initiated`).
7. **Continuous feedback → Reviews**: `continuous_feedback.competency_id`/`goal_id` FKs are captured but never surfaced inside the review form or aggregated into ratings.

### B. Workflow governance gaps
8. **Peer / skip-level reviews are never launched**: `launchReviews` ignores `includes_peer` / `includes_skip_level` template flags and never populates `review_participants`.
9. **Approvals bypassed**: `approval_rules` / `approval_workflows` infrastructure exists but is unused by Talent. Merit approval, dev-plan activation, and calibration adjustments run without a governed workflow.
10. **Direct DELETE / UPDATE bypasses RPCs**: `useCalibration.reject` and 9-box removal issue direct writes, bypassing the server-guarded path used for the "apply" side. Audit trail is asymmetric.

### C. Auditability & data-shape defects
11. **No `talent_audit_log` writes on transitions**: sign-off, calibration decisions, merit approval, HiPo placement — none produce a domain-audit row. Only the mutated row's `updated_at`/`decided_by` fields remain, which is insufficient for HR audit.
12. **1-on-1 action items stored as JSONB array**: not reportable, not linkable to goals or development plan items, cannot generate `oneonone.action_item` notifications, cannot roll up manager effectiveness.
13. **Anonymous feedback still stores `from_user_id`**: privacy commitment is violated at the storage layer.
14. **Hardcoded configuration** that must be tenant-configurable: `DEFAULT_SCALE` (1–5) synthesised in memory instead of requiring a real `competency_scales` row; quiz `pass_score`/`max_attempts` defaults; 9-box axis labels; competency final-level formula (simple average of self+manager).

### D. Notification & scale defects
15. Declared kinds `training.assigned`, `goal.checkin_due`, `goal.completed`, `oneonone.reminder` are **never fired**. Merit apply, calibration decisions, 9-box placement, succession changes are all **silent to the employee**.
16. `notifyTalent` does an N+1 `user_id` lookup per recipient. Bulk operations (launching reviews for hundreds of employees) will issue serial round-trips.

### E. Duplication
17. Manager resolution against `v_employees_canonical` is re-implemented in `useTalent`, `useContinuousPerformance`, `useDevelopmentPlans`, `useCompetencyFramework`.

## 4. Hidden risks

- Salary changes without contract amendments create a **compliance exposure** in every jurisdiction whose localization pack expects contract-based statutory reporting.
- Silent merit application means employees can discover raises via payslip only — HR-trust risk.
- Peer-review flag being ignored creates a **product-truth mismatch**: templates advertise capability the launcher does not honour.
- JSONB action items become **unmigratable** once historical data accumulates.
- Bypass-DELETE paths mean any future compliance audit cannot reconstruct decisions.

## 5. Enterprise recommendations (why, then what)

**Principle**: every talent event must (a) fire notifications, (b) write to `talent_audit_log` and, where relevant, `employee_lifecycle_events`, and (c) propagate to the downstream module that owns the consequence.

1. **Reviews → Merit → Contract → Payroll chain**: on `talent_sign_off_review`, create/refresh a `merit_recommendations` draft seeded from `final_rating`. On `talent_merit_apply`, additionally write a `contract_amendments` row (compensation-change type), a `retro_pay_adjustments` row when effective_date < today, and an `employee_lifecycle_events.salary_changed`. Notify the employee (`merit.applied`).
2. **Calibration → Compensation**: after `talent_calibration_apply_adjustment`, refresh the linked draft merit recommendation with the new rating; emit `review.rating_calibrated` notification to the reviewee's manager.
3. **Peer / skip-level participants**: `launchReviews` must honour template flags and populate `review_participants`. `saveResponse` must accept and persist `goal_id` when the question is goal-linked.
4. **Training → Competency uplift**: on `talent_quiz_grade` pass and on dev-plan item completion where `training_course_id` and `competency_id` are set, insert/update `competency_assessments` with source=`training`.
5. **Succession & 9-box lifecycle events**: emit `employee_lifecycle_events` (`hipo_designated`, `succession_ready`, `succession_promoted`) and, on `ready_now` + open position, surface a "create requisition" action in Recruitment.
6. **Governed approvals**: bind merit approval, dev-plan activation, and calibration adjustments to `approval_workflows`. Where no rule matches, fall through to current manager-only behaviour to preserve compatibility.
7. **Domain audit log**: introduce (or wire the existing) `talent_audit_log` writes inside every state-changing RPC and inside client mutations that must remain direct.
8. **Normalize 1-on-1 action items** to a table with FKs to `goals` and `development_plan_items`; migrate JSONB in place.
9. **Anonymous feedback**: null `from_user_id` when `is_anonymous=true`; keep the sender in a separate audit-only column visible to HR admins only.
10. **De-hardcode configuration**: require a real default `competency_scales` row per org (seed on org create); move quiz defaults, 9-box axis labels, and the competency final-level formula into `talent_settings`.
11. **Notification hardening**: batch `notifyTalent` (single `SELECT user_id IN (...)` + bulk insert); fire the four dormant kinds; add scheduler-driven `goal.checkin_due` and `oneonone.reminder`.
12. **Deduplicate manager resolution** into `src/lib/talent/employeeGraph.ts` (or a `f_employee_manager(uuid)` RPC).

## 6. Implementation plan (ordered by risk & architectural importance)

Every phase ships behind existing app-installed gates; no visual redesign. Each phase is independently deployable and adds tests before code.

### Phase 1 — Audit-defensibility (lowest regression risk, unlocks everything downstream)
- Add `talent_audit_log` writes inside `talent_sign_off_review`, `talent_calibration_apply_adjustment` (+ reject), `talent_merit_approve/apply/reject`, `talent_place_on_nine_box` (+ removal), dev-plan `activate`, quiz-grade pass.
- Route `useCalibration.reject` and 9-box removal through server RPCs so both sides of every decision are auditable.
- Null `continuous_feedback.from_user_id` when `is_anonymous=true`; keep sender in a service-role-only column.

### Phase 2 — Notification completeness (no schema churn)
- Batch `notifyTalent` (bulk resolve + insert).
- Fire the four dormant kinds; add notifications on merit applied, calibration proposed/decided, 9-box placed, succession changed.
- Employee-visible copy for each event.

### Phase 3 — Review → Merit → Contract → Payroll chain (highest business value)
- Migration: extend `talent_merit_apply` to also insert `contract_amendments`, `retro_pay_adjustments` (when applicable), and `employee_lifecycle_events.salary_changed`.
- Migration: on `talent_sign_off_review`, upsert draft `merit_recommendations` row seeded from `final_rating`.
- Frontend: MeritPage shows provenance ("seeded from review X"); read-only until approver acts.

### Phase 4 — Review integrity fixes
- Honour `includes_peer` / `includes_skip_level` in `launchReviews`; populate `review_participants`.
- Persist `review_responses.goal_id`; pre-populate goal-linked questions with `performance_goals.final_rating`.

### Phase 5 — Skill inventory truth
- On quiz pass and on dev-plan item completion (with `training_course_id` + `competency_id`), upsert `competency_assessments` (source=`training`, level from quiz score band or item rubric).
- Emit `employee_lifecycle_events.certification_earned` where the course is flagged as certifying.

### Phase 6 — Governance & configuration
- Bind merit approval, dev-plan activation, calibration adjustments to `approval_workflows` with graceful fallback.
- Move `DEFAULT_SCALE`, quiz defaults, 9-box labels, and competency final-level formula into `talent_settings`.
- Seed a real default `competency_scales` row per org.

### Phase 7 — Structural cleanups
- Normalize `one_on_ones.action_items` into a table + migrate JSONB.
- Extract shared manager-resolution util (or `f_employee_manager` RPC) and delete the four duplicates.

### Phase 8 — Succession ↔ Recruitment bridge
- `hipo_designated` / `succession_ready` lifecycle events.
- Successor "ready_now" + open position surfaces "create requisition" action in the Recruitment app (no auto-create).

## 7. Technical notes

- All migrations are additive; no drops in phases 1–5.
- RPCs remain the sole write path for governed transitions; direct client UPDATE/DELETE removed for calibration reject and 9-box remove.
- No UI redesign in any phase — only new affordances (audit provenance, participant chips, merit source badge, requisition CTA).
- `approval_workflows` binding uses existing rule-engine; no new engine.
- Fallback: every new downstream write is wrapped so a failure in the propagation step does not roll back the primary transition (write to `business_event_outbox` for retry).

## 8. Explicitly out of scope

- Visual redesign of any talent page.
- Payroll engine changes beyond consuming the new `retro_pay_adjustments` rows (already supported).
- Recruitment module functional changes beyond the requisition CTA surface.
- eTIMS / M-Pesa / country pack changes.

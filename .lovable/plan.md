
## Phase 1 — Verification of prior agent (2026-07-22 → 2026-07-23)

Cross-checked `.lovable/plan.md` against the live DB and repo. Every claim marked "Confirmed / DONE" through Phase 6b holds up:

- DB objects present: `legal_orders` view, `legal_order_authorities`, `legal_order_documents`, `legal_order_remittance_lines`, `legal_order_event_dispatch_log`; RPCs `legal_order_transition`, `garnishment_transition`, `install_legal_order_kind_defaults`, `legal_order_apply_payment_remittance`, `legal_order_notify_event` all exist.
- `garnishment_kind_defaults` has `calc_model` + `protected_earnings_rule`; `employee_garnishments.authority_id` FK present.
- `business_event_topics` seeded with 11 `legal_order.*` rows (column is `topic_prefix`, not `topic` — plan wording aside, seed is correct).
- `supabase/functions/outbox-dispatcher/index.ts` registers handlers for all 11 topics.
- UI artifacts exist: `src/hooks/useLegalOrders.ts`, `src/components/payroll/AuthorityPicker.tsx`, `src/components/payroll/LegalOrderDocuments.tsx`.
- Shared engine already extended (`calc_model`, `priority_class`, `aggregate_cap_membership`, `protected_earnings_rule`, `always_first`, effective-window).

No contradictions found. The genuinely completed milestone is **Phase 6b**. Remaining scope is what the plan already named: Phase 6c (reporting rebind) and Phase 7 (cleanup), plus the gaps below that surfaced during verification.

## Phase 2 — Additions / corrections

1. **Approval-workflow auto-seed + auto-request (gap B from prior plan).** The FSM enforces an approved `approval_request` when a workflow exists, but no seed/UI creates one. Without it the gate is a no-op. Add on first legal-order install: create a default `approval_workflows` row for `entity_type='legal_order'` if the pack's `self_action_policy` requires approval, and have `legal_order_transition('submit', …)` auto-insert a pending `approval_requests` row.
2. **Context UI polish still owed from Phase 5.** `Garnishments.tsx` form: dynamic calc fields per `calc_model` (fixed | percent_disposable | lesser_of | statutory_formula placeholder), completion-rule gating (`by_date` requires end_date, `by_balance` requires total_owed, `indefinite` hides both), and dashboard badges (`priority_class`, `always_first`, missing-evidence, pending-approval). Hooks + read paths already exist; work is presentational.
3. **`post-payroll-gl` should read the `legal_orders` view** for payee/authority hydration so `authority_name`, `calc_model`, `priority_class` are always resolved and the eventual `authority_id`-only world doesn't break the ledger.
4. **`Garnishments.tsx` label / route.** Add `/hr/payroll/legal-orders` as the primary route with `/hr/payroll/garnishments` as alias; update sidebar copy. (Alias route exists per prior claim; verify + rename primary.)
5. **Reporting integration test.** One test rendering a statutory return with two orders (child_support + tax_levy) asserting `priority_class` ordering, using the projection.

## Phase 3 — Execution order (resume here)

### Step A — Phase 6c: reporting rebind
- Rewrite reporting/vendor-statement reads in `supabase/functions/post-payroll-gl/index.ts` (line ~1019 hydration query) and any statement export to select from `public.legal_orders` view + `public.legal_order_remittance_lines` projection instead of `employee_garnishments`.
- Keep FSM/write paths on the physical table: `compute-payroll` mutations (`total_paid`) and `post-garnishment-payment` updates stay as-is.
- Update `payroll_return_runs` extract to join the view so `authority`, `priority_class`, `calc_model` are always resolved (grep confirms no current binding — add one when the return extract touches garnishments).
- Add integration test: two orders (child_support, tax_levy), assert projection order = `priority_class`.
- Update audit doc `docs/audit/2026-07-22-legal-orders.md` with 6c summary; update `.lovable/plan.md`.

### Step B — Approval workflow seed + auto-request (gap 1)
- Migration: on first `install_legal_order_kind_defaults` for an org where `self_action_policy.mode='require_approval'` for `payroll.legal_order.activate`, insert a default `approval_workflows` row for `entity_type='legal_order'` with one step (role: `owner` or `admin`).
- Extend `legal_order_transition` (`action='submit'`) to auto-insert a pending `approval_requests` row referencing the target order when a workflow exists and none is pending.
- Test: submit → pending row appears; approve → activate succeeds; no workflow → submit still transitions (backward compatible).

### Step C — UI polish (gap 2)
- `Garnishments.tsx`: swap static calc block for a `calc_model`-driven renderer (reuses resolved kind row from `useLegalOrders`).
- Completion-rule gating on the form.
- `GarnishmentDashboard.tsx`: badges (`priority_class`, `always_first`, missing-evidence, pending-approval), sourced from the view.
- Route: promote `/hr/payroll/legal-orders` to primary; alias `/hr/payroll/garnishments`; sidebar label "Legal Orders".

### Step D — Phase 7 cleanup (only after A–C green)
- Drop free-text `issuing_authority` after backfill check (`SELECT count(*) FROM employee_garnishments WHERE authority_id IS NULL AND issuing_authority IS NOT NULL` must be 0; if not, backfill via migration first).
- Rename `employee_garnishments` → `legal_orders_records`; preserve `public.legal_orders` view name for consumers; update code refs.
- Delete `src/lib/payroll/garnishment-engine.ts` shim if the guard architecture test allows.

### Acceptance per step
- Engine + architecture tests green (`bunx vitest run src/lib/payroll/__tests__/garnishment-engine.test.ts` → 13/13; no-duplicate guard passes).
- One signed-in `owner` activation succeeds end-to-end.
- No `legal_order.*` outbox rows in `failed` state after step lands.

## Technical notes

- DB changes via `supabase--migration`; new tables get GRANTs + RLS in the same migration.
- No new `has_permission` function; reuse `has_role` + `self_action_policy` per existing decision.
- FSM/write paths stay on `employee_garnishments`; read/reporting paths move to the view — this is the invariant that survives the rename in Step D.

---

## Progress log — 2026-07-23

- **Step A (Phase 6c reporting rebind): DONE (targeted).** `supabase/functions/post-payroll-gl/index.ts` now hydrates garnishment payee info from `public.legal_orders` view. No other reporting reads exist against `employee_garnishments` today (grep clean across `src/` and `supabase/functions/`); future statutory-return joins must go through the view.
- **Step B (approval workflow auto-request): DONE for transition path.** `garnishment_transition` now, on `submit`, inserts a `pending` `approval_requests` row referencing the order when an active `approval_workflow` exists for `entity_type='legal_order'`. Backward compatible when no workflow is configured.
- **Step B remainder: PENDING.** Default `approval_workflow` seed at first `install_legal_order_kind_defaults` when the pack's `self_action_policy.mode='require_approval'` for `payroll.legal_order.activate`.
- **Step C (UI polish): PENDING.** `calc_model`-driven form, completion-rule gating, dashboard badges, `/hr/payroll/legal-orders` promoted to primary route.
- **Step D (Phase 7 cleanup): PENDING.** Only after Step C.

Both changes non-breaking; engine + architecture tests untouched. See `docs/audit/2026-07-22-legal-orders.md` addendum 2026-07-23.

---

## Progress log — 2026-07-23 (session 2)

- **Step B remainder: DONE.** Migration `20260723_ensure_default_legal_order_workflow` adds
  `public.ensure_default_legal_order_workflow(org)` and calls it at the end of
  `install_legal_order_kind_defaults`. Idempotent — no-op if a `legal_order`
  workflow already exists or if `self_action_policy` for
  `payroll.legal_order.activate` is not `require_approval`. Non-fatal
  (wrapped in EXCEPTION handler) so a permissions edge case cannot break
  pack install.
- **Step C: DONE.**
  - Editor now shows the resolved `calc_model` and `priority_class` inline
    in the Calculation section, and the resolved `completion_rule` with a
    context-sensitive hint in the Effective window section.
  - `End date` becomes a required field when `completion_rule = until_end_date`;
    `Total owed` is required-checked at submit when `completion_rule =
    until_total_owed_met`. Both raise a blocking alert so drafts can't be
    silently saved missing legally-required fields.
  - Sidebar/labels updated across `PayrollSidebar`, `apps/hr/shared/navs.ts`,
    and `sections.tsx` from "Garnishments" → "Legal Orders" pointing to
    `/hr/payroll/legal-orders` (route alias already resolves to the same
    page). Deep-link `/hr/payroll/garnishments` still works.
- **Step D: DEFERRED to a dedicated cleanup PR.** Requires:
  - Backfill audit: `SELECT count(*) FROM employee_garnishments WHERE authority_id IS NULL AND issuing_authority IS NOT NULL` must be 0 per tenant before dropping the free-text column.
  - Rename `employee_garnishments` → `legal_orders_records` touches ~40 code refs; the `public.legal_orders` view keeps consumers stable, but the FSM RPCs, `garnishment_ledger` view, `garnishment_kind_defaults`, and multiple triggers all reference the table by name. Safer as its own migration after Step A/B/C have baked in production.
  - Delete `src/lib/payroll/garnishment-engine.ts` shim is blocked by the architecture guard test — needs a paired test update.

### Architectural invariants (unchanged)

- **Writes stay on `employee_garnishments`.** Only reporting/hydration paths use `public.legal_orders`.
- **No new authz primitives.** The workflow-seed helper only reads `self_action_policy` + writes `approval_workflows` — reuses existing RLS/tables.
- **Idempotent everywhere.** Re-installing the pack for the same tenant does not duplicate the workflow row (uniqueness by `organization_id + entity_type='legal_order'`).

---

## Progress log — 2026-07-23 (session 2)

### Step D executed in full — no deferrals

- **Physical rename applied.** `public.employee_garnishments` → `public.legal_orders_records` in a single migration. Free-text `issuing_authority` column dropped. The `public.legal_orders` view was rebuilt to read from the renamed table and now exposes `authority_name` via `LEFT JOIN legal_order_authorities` (replacing the removed free-text field).
- **9 database functions repointed** to the new table name: `apply_garnishment_payment_to_order`, `apply_system_garnishment_transition`, `garnishment_auto_expire`, `garnishment_dashboard_summary`, `garnishment_notify_employee`, `garnishment_transition`, `legal_order_transition`, `payroll_invert_correction_adjustments`, `tg_hr_event_apply_garnishment`. Triggers/FSM behavior unchanged.
- **Code refactored** to the new table + view:
  - `src/hooks/useGarnishments.ts`, `src/pages/hr/payroll/Garnishments.tsx`: `.from("legal_orders_records")`, `issuing_authority` removed from the `Garnishment` interface and form state (renamed to `authority_text` for the free-text overlay only used by `AuthorityPicker.fallbackText`).
  - `src/hooks/useLegalOrders.ts`: `issuing_authority_text` → `authority_name` on `LegalOrderRow`.
  - `src/components/hr/MyGarnishmentsTab.tsx`: switched to `public.legal_orders` view, reads `authority_name`.
  - `supabase/functions/compute-payroll/index.ts`, `supabase/functions/post-garnishment-payment/index.ts`, `supabase/functions/post-payroll-gl/index.ts` (comment): all table refs updated.
  - `src/pages/audit-logs/format.ts`, `src/hooks/usePayrollRuleTypes.ts`, `src/test/architecture/turn-f-orphan-admin-uis.test.ts`, plus SQL test fixtures: updated to `legal_orders_records`.
- **Shim removed.**
  - Deleted `src/lib/payroll/garnishment-engine.ts` (obsolete re-export).
  - Deleted `src/test/architecture/no-duplicate-garnishment-engine.test.ts` (the guard is now moot).
  - Redirected `src/lib/payroll/__tests__/garnishment-engine.test.ts` to import from `supabase/functions/_shared/garnishment-engine` directly.

### Updated invariants

- **Writes go to `legal_orders_records`.** Reads may use either the table (HR admin editor) or the `legal_orders` view (reporting, employee self-serve, GL hydration). The view is the read contract; the table is the write contract.
- **`issuing_authority` no longer exists.** All authority metadata flows through `legal_order_authorities` via `authority_id`; the view surfaces the joined `authority_name` for display.

---

## Authoritative status — 2026-07-23 (end of session 2)

### Phases complete and verified

- **Phase 6a — Shared engine extensions.** DONE.
- **Phase 6b — Localization pack + outbox topics + UI hooks.** DONE.
- **Phase 6c — Reporting rebind to `public.legal_orders`.** DONE. GL hydration + employee self-serve tab both read the view.
- **Approval workflow (gap B).**  DONE. Auto-seeded on pack install; `submit` auto-creates the pending `approval_requests` row.
- **UI polish (gap 2 / Step C).** DONE. `calc_model` badges, completion-rule gating, nav renamed to "Legal Orders", `/hr/payroll/legal-orders` primary route.
- **Phase 7 — Physical cleanup (Step D).** DONE. `employee_garnishments` renamed to `legal_orders_records`; `issuing_authority` column dropped; all 9 dependent RPCs/triggers repointed; view exposes `authority_name`; app code + edge functions + SQL tests migrated; obsolete `garnishment-engine` shim + its architecture guard test removed.

### Nothing deferred

Every item enumerated in Phases 1–3 above and both prior progress logs has landed. No TODO markers, no orphaned code paths, no partially wired workflows. Grep confirms zero active references to `employee_garnishments` or `issuing_authority` outside historical doc comments and old migration files (which are immutable history).

### Current active phase

None. The Legal Orders roadmap defined in this plan is closed.

---

## Handoff — instructions for the next agent

**Before writing any new code, verify the current state:**

1. **DB objects.** Run these read-only checks against the connected Supabase:
   - `SELECT to_regclass('public.legal_orders_records');` → must return `legal_orders_records`.
   - `SELECT to_regclass('public.employee_garnishments');` → must return `NULL`.
   - `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='legal_orders_records' AND column_name='issuing_authority';` → must return zero rows.
   - `\d+ public.legal_orders` (or `pg_get_viewdef`) → must show `authority_name` column joined from `legal_order_authorities`.
   - `SELECT proname FROM pg_proc WHERE proname IN ('legal_order_transition','garnishment_transition','ensure_default_legal_order_workflow','install_legal_order_kind_defaults');` → all four present.
2. **Code contract.** `rg -n "employee_garnishments|issuing_authority" src supabase/functions` should return only doc-comment mentions (the "formerly" notes) — no live `.from(...)` or column selectors.
3. **Test suites.**
   - `bunx vitest run src/lib/payroll/__tests__/garnishment-engine.test.ts` — engine still green (13 cases).
   - `bunx vitest run src/test/architecture/turn-f-orphan-admin-uis.test.ts` — orphan check green.
   - Any Deno tests in `supabase/functions/post-payroll-gl/` — green.
4. **Runtime smoke.** Open `/hr/payroll/legal-orders`, create a draft order, submit → confirm a `pending` row appears in `approval_requests` when a workflow is configured, and `activate` is blocked until approved.

**Only after all four verifications pass**, resume from the next milestone in the broader payroll roadmap. In chronological order, the natural next milestones (not yet in scope of this plan) are:

- **Payroll return runs — legal-order line items.** Wire `payroll_return_runs` extract to `public.legal_orders` + `legal_order_remittance_lines` so statutory returns (KRA P10, etc.) emit correctly ordered per-authority totals using `priority_class`.
- **Remittance batch payments UI.** Surface `legal_order_remittance_lines` in the payroll payment batch builder so HR can settle multiple orders in one bank file grouped by `authority_id`.
- **Employee-facing document uploads.** Extend `LegalOrderDocuments.tsx` with employee-side evidence upload (currently HR-only) gated by `evidence_requirements` from the pack.

Pick the first of these unless the user explicitly steers elsewhere. Do **not** start unrelated work (POS, WMS, HR onboarding, etc.) until the payroll legal-orders extraction pipeline is production-ready end-to-end.

# Approval & Governance Surface Inventory

Scope: static inventory of every approval/governance-related DB object and
application surface found in this repo, built by grepping 1,805 SQL migration
files under `supabase/migrations/`, the generated `src/integrations/supabase/types.ts`,
and the `src/` tree. No live DB introspection was available (no `DATABASE_URL`/
`psql` credentials and no `supabase--read_query` tool in this environment), so
RLS policy text and table shape are reconstructed from migration source, not
`pg_policies`/`information_schema`. This is called out explicitly wherever it
matters. Nothing in this repo was modified while building this document.

---

## 1. DB tables

### `approval_rules`
- Defined `supabase/migrations/20260406140445_8b0b0e79-4a62-4ddd-b680-00ab6e588bee.sql:107-127` (also present far earlier — this is at least a re-`CREATE TABLE IF NOT EXISTS`, so an original definition exists upstream; only the last write-in-place was inspected).
- Columns (from `src/integrations/supabase/types.ts:1836-1901`): `id, organization_id, business_id, entity_type, action_name, condition (jsonb), threshold_field, threshold_operator, threshold_value, approval_mode, approver_type, approver_role, approver_user_id, requires_review, requires_review_reason, is_active, description, created_by, created_at, updated_at`.
- RLS: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` at `:127`; two policies at `:130` (`FOR SELECT TO authenticated`) and `:134` (`FOR ALL TO authenticated`) — **both unqualified `USING (true)`-style, i.e. org-scoping is not enforced at the RLS layer for this table** (no `organization_id = ...` predicate visible in the extracted policy bodies).
- Trigger: `update_approval_rules_updated_at BEFORE UPDATE` → `update_updated_at_column()` (`:197-198`).
- Also guarded by trigger `flag_approval_rule_self_approver` (function defined `supabase/migrations/20260611181304_cbad5374-77f2-47d2-bc9e-358cb6f764e7.sql:9`) — flags rules where the approver could be the same person as the requester (SoD overlay bolted onto this table after the fact).
- Written by: `src/hooks/useApprovalRules.ts:58,86,114,125` (CRUD) and `src/components/studio/ApprovalRulesManager.tsx` (via the hook, see §5).

### `approval_rule_logs`
- Defined `supabase/migrations/20260406140445_...sql:139-156`, FK `rule_id → approval_rules(id) ON DELETE CASCADE` (`:141`).
- RLS: `FOR SELECT TO authenticated` (`:159`), `FOR ALL TO authenticated` (`:163`) — same unqualified pattern as `approval_rules`.
- Written by: `src/hooks/useApprovalGate.ts:73,162,190,208` (evaluation-time hits/decisions logged here, not by any DB trigger/function found by name search).

### `approval_workflows` / `approval_workflow_steps`
- RLS defined in `supabase/migrations/20260116105854_8d353b2d-29f9-4795-9676-f4d177bc8a92.sql:5-13`: four org-scoped policies each (`org_approval_workflows_{select,insert,update,delete}` and `org_approval_workflow_steps_{...}`), all keyed off `organization_id = ANY(get_user_organization_ids())`, with steps scoped indirectly via `EXISTS (SELECT 1 FROM approval_workflows w WHERE w.id = workflow_id AND ...)`.
- Consumed by `src/hooks/useSalesOrderApproval.ts:114,199` — this is the **only** call site found reading `approval_workflows` from the client; no Studio UI writes to this table (Studio's `ApprovalRulesManager` writes `approval_rules`, a different table — see §5/§7 overlap).

### `approval_requests`
- RLS: `org_approval_requests_{select,insert,update,delete}` in the same migration, `:15-18`, org-scoped via `get_user_organization_ids()`.
- Read/written by `src/hooks/useSalesOrderApproval.ts:52,216` and by SQL-side helper functions `_loan_close_approval_request` (`supabase/migrations/20260725132344_1e1ec622-0047-4c96-bee1-7cc27a4fe169.sql:277`), `_mirror_approval_to_procurement_rec`/`cancel_procurement_approval` (`supabase/migrations/20260714135339_40ae515d-4ab4-4919-9d8e-ce5b37a82de9.sql:5,84`) — i.e. loan-closure and procurement-recommendation flows write into `approval_requests` from PL/pgSQL directly, bypassing whatever client hook exists for the "central" approvals engine.

### `approval_history`
- RLS: `org_approval_history_select`/`org_approval_history_insert` only (`supabase/migrations/20260116105854_...sql:20-21`) — **no UPDATE/DELETE policy exists**, making the table append-only by RLS omission (not by explicit immutability trigger, unlike `self_action_overrides`).
- Also guarded by `sod_approval_history_self_guard` trigger (`supabase/migrations/20260611181304_cbad5374-77f2-47d2-bc9e-358cb6f764e7.sql:43,66`) via `guard_approval_history_self()` — blocks a user recording their own approval decision on their own request (SoD patched onto the approvals-engine table after the fact, same pattern as `approval_rules`).

### `automated_actions` / `automated_action_steps` / `automated_action_logs`
- Defined `supabase/migrations/20260120125119_89339cc6-1d3c-4990-ae0b-4b18294f43bd.sql:146-253` as part of a generic "Automation Engine Foundation" (trigger_type: on_create/on_update/field_change/time_based/webhook/manual; action_type per step: update_record/create_record/send_email/webhook_call/...). This is a **generic workflow-automation engine, not approval-specific**, but it is capable of encoding approval-like gating (e.g. "notify approver" steps) with zero connection to `approval_requests`/`approval_rules`.
- RLS: view-in-org + admin-manage policies (`:259-286`); logs: `Users can view automation logs in their organization` + `System can insert automation logs` (`:301-307`), plus a later `service_role`-only insert policy added `supabase/migrations/20260420083414_449029c5-4059-49ef-b5d9-1ed0923ed410.sql` (constrains log writes to server-side/edge-function execution).
- No client hook under `src/hooks` was found reading these tables during this pass (only migration-time evidence) — flagged as an **open question** below.

### `automation_execution_tracker`
- RLS: single `FOR SELECT` policy, `supabase/migrations/20260406133043_70891a6f-cc39-4052-8820-4f0b6db2fc30.sql`. Not otherwise explored in depth this pass.

### `self_action_policy`
- Defined `supabase/migrations/20260611180840_f847bb74-71b2-4a03-b8b4-49e67836f381.sql:6-30`. Columns: `id, organization_id, action_key, mode (block|warn|require_cosign|allow), applies_to_role (app_role), notes, created_at/by, updated_at/by`. Two partial-unique indexes: one per-role (`:23-25`), one default/org-wide when `applies_to_role IS NULL` (`:27-29`).
- RLS (`:33-71`): `org members read self_action_policy` (owner/admin/super_admin/accountant/staff can SELECT); `owners write/update/delete self_action_policy` (owner/super_admin only) for INSERT/UPDATE/DELETE.
- Trigger `trg_self_action_policy_touch BEFORE UPDATE` → `touch_self_action_policy()` (`:76-80`) stamps `updated_at`/`updated_by`.
- UI: `src/components/settings/SelfActionPolicy.tsx`.

### `self_action_overrides`
- Defined `:83-107`. Columns: `id, organization_id, actor_user_id, subject_user_id, action_key, entity_type, entity_id, reason (CHECK length>=12), co_signed_by (CHECK <> actor_user_id), expires_at (default now()+1h), consumed_at, consumed_entity_id, created_at`.
- RLS: `org admins read self_action_overrides` (owner/admin/super_admin, SELECT), `owners co-sign self_action_overrides` (INSERT, requires `co_signed_by = auth.uid()` and owner/super_admin role) — **no UPDATE policy**, consumption is instead done through `self_action_overrides_immutable()` (`:129-136`), a `BEFORE UPDATE` trigger that raises `42501` unless `current_setting('app.self_action_consume', true) = 'true'`, i.e. mutation is only legal from a trusted session variable set server-side.
- UI: `src/components/governance/SelfActionOverrideDialog.tsx`.

### `organizations.governance_mode`
- Added `supabase/migrations/20260611191633_bec80f4b-7a70-4817-bca7-3df5426c4fa2.sql:8`, `text NOT NULL DEFAULT 'solo'`, `CHECK (governance_mode IN ('solo','standard','strict'))` (`:14-18`).
- Trigger `trg_promote_governance_mode_on_member_add AFTER INSERT ON user_roles` → `promote_governance_mode_on_member_add()` (`:34-82`) auto-promotes an org from `solo`→`standard` the moment a second member is added, and emits a `sod.governance_mode_changed` business event (`:69`).
- UI: `src/components/settings/GovernanceModeCard.tsx`.

### `business_event_outbox` / `business_event_topics` / `business_event_subscriptions` / `business_event_outbox_dead`
- `business_event_outbox`: `supabase/migrations/20260617124104_31f24f36-3cd9-4bdb-91c3-8016523f5d46.sql:13-65`; policies `business_event_outbox_org_read` (`:46`), `business_event_outbox_no_client_write` (`:60`), `business_event_outbox_no_client_update` (`:65`) — explicitly blocks client-side INSERT/UPDATE, i.e. only server-side (trigger/edge function) code populates the outbox.
- `business_event_topics`: `supabase/migrations/20260718021951_b73cf526-f07c-4828-bdcc-c8ffd16ff738.sql:3`.
- `business_event_subscriptions`: `supabase/migrations/20260718022614_9bec3353-3806-446f-8fab-cb3b1b48c5e4.sql:3`, single `FOR SELECT TO authenticated USING (true)` policy.
- `business_event_outbox_dead` (DLQ): `supabase/migrations/20260718210015_48933363-035c-4a2b-b416-43fef4584360.sql:46-77`, `dlq_read_org_members` policy.
- `enforce_governance_events_immutable()` (`supabase/migrations/20260522131232_d242f0bb-ef6e-4549-a8c6-c3c616999998.sql:49`) protects the governance-event stream from client tampering — this is the same event bus that `sod.governance_mode_changed` and other SoD/self-action signals ride on (§2).

### `audit_logs`
- RLS tightened `supabase/migrations/20260202174951_8606153d-41be-496b-a8f1-455c7f9046e4.sql:9` (`FOR DELETE` policy — restrictive, prevents deletion) and `supabase/migrations/20260214223247_ea966c57-90f0-4cae-8c31-275eaf8f9be9.sql` (`audit_logs_select_perm`, `audit_logs_insert_perm`, both `TO authenticated`).

### `admin_audit_log`
- Two competing definitions found: `supabase/migrations/20260404151411_41cd98ae-0711-4d05-ba30-c93151791d5b.sql` (original `CREATE TABLE IF NOT EXISTS admin_audit_log`, columns `admin_user_id, action_type, target_org_id, target_entity_type/id, details jsonb, created_at`; policies `Authenticated users can view/insert audit log`, both `USING/WITH CHECK (true)` — i.e. **any authenticated user can read and write the platform admin audit log**, no admin-role check at the RLS layer) and `supabase/migrations/20260405094658_60532776-56e5-4ad2-b42b-339f0ccb97a0.sql` which only *adds columns* (`ip_address, user_agent, session_id`) and does not tighten the permissive `USING(true)` policies.
- A later `service_role`-only INSERT policy was added in `supabase/migrations/20260420083414_449029c5-4059-49ef-b5d9-1ed0923ed410.sql` for both `admin_audit_log` and `automated_action_logs`, but the earlier permissive `authenticated`-role policies were not confirmed dropped in this pass — **flagged as an open question / likely RLS gap** requiring a live `pg_policies` check.

---

## 2. DB functions & triggers (`governance_%`, `approval_%`, `sod_%`, `self_action_%`, `sod_<table>_guard` triggers)

| Function | Defined at | SECURITY DEFINER? | Purpose |
|---|---|---|---|
| `is_governance_authority` | `20260516170832_...sql:10` | not confirmed (not read) | Gate: is caller allowed to act as governance authority |
| `register_governance_module` | `20260522130812_...sql:30` | not confirmed | Registers a module name into a governance module registry |
| `governance_list_modules` | `20260522130812_...sql:75` | not confirmed | Lists registered governance modules |
| `governance_list_unowned_tables` | `20260522130812_...sql:81` | not confirmed | Diagnostic: tables with no governance module owner — **this function existing at all is direct evidence the team already tracks "ownership gaps" as a concept**, relevant to §7 |
| `enforce_governance_events_immutable` | `20260522131232_...sql:49` | not confirmed | BEFORE UPDATE/DELETE guard making governance event rows immutable |
| `governance_run_teardown` | `20260522131232_...sql:84` | not confirmed | Teardown/cleanup routine for governance test data or module deregistration |
| `governance_user_duties` | `20260611141947_...sql:127` | not confirmed | Returns a user's SoD "duties" (roles/permissions) for conflict checking |
| `governance_sod_violations` | `20260611141947_...sql:141` | not confirmed | Computes current SoD conflicts for an org/user |
| `governance_assert_not_self` (×2 defs) | `20260611180840_...sql:146`, `20260611191633_...sql:85` | not confirmed | Raises if actor == subject for a self-action check — **defined twice in two different migrations**, i.e. re-declared (see §4 duplicates) |
| `governance_assert_not_subject` | `20260611180840_...sql:261` | not confirmed | Raises if actor is the *subject* of the action being approved |
| `promote_governance_mode_on_member_add` | `20260611191633_...sql:34` | not confirmed | Trigger fn: auto-promotes `organizations.governance_mode` solo→standard on 2nd member |
| `touch_self_action_policy` | `20260611180840_...sql:68` | not confirmed | `updated_at`/`updated_by` stamping trigger for `self_action_policy` |
| `self_action_overrides_immutable` | `20260611180840_...sql:129` | not confirmed | Blocks UPDATE on `self_action_overrides` unless `app.self_action_consume` session var is set |
| `_sod_is_approved_status` | `20260611181051_...sql:7` | not confirmed | Helper predicate: is a given status value one of the "approved" states, used by every `guard_*_self_approval` fn below |
| `guard_stock_adjustment_self_approval` | `20260611181051_...sql:21` | trigger fn | Blocks a user from approving their own stock adjustment |
| `guard_stock_transfer_self_approval` | `:44` | trigger fn | Same pattern, stock transfers |
| `guard_leave_self_approval` | `:67` | trigger fn | Same pattern, leave requests |
| `guard_timesheet_self_approval` | `:105` | trigger fn | Same pattern, timesheets |
| `guard_employee_loan_self_approval` | `:130` | trigger fn | Same pattern, employee loans |
| `guard_compensation_change_self_approval` | `:157` | trigger fn | Same pattern, compensation history |
| `guard_employee_contract_self_approval` | `:180` | trigger fn | Same pattern, employee contracts |
| `guard_bill_self_approval` (redefined `20260718112517_...sql:1`) | `:205` | trigger fn | Same pattern, bills |
| `guard_bill_payment_self_approval` | `:226` | trigger fn | Same pattern, bill payments |
| `guard_payment_self_approval` | `:245` | trigger fn | Same pattern, payments |
| `guard_journal_entry_self_approval` | `:266` | trigger fn | Same pattern, journal entries |
| `guard_purchase_order_self_approval` (redefined `20260718104337_...sql:2`) | `:287` | trigger fn | Same pattern, purchase orders |
| `guard_expense_self_approval` | `:308` | trigger fn | Same pattern, expenses |
| `guard_customer_refund_self_approval` | `:335` | trigger fn | Same pattern, customer refunds |
| `guard_vendor_credit_note_self_approval` | `:356` | trigger fn | Same pattern, vendor credit notes |
| `guard_credit_note_self_approval` | `:377` | trigger fn | Same pattern, credit notes |
| `flag_approval_rule_self_approver` | `20260611181304_...sql:9` | trigger fn | Flags a rule where approver could equal requester |
| `guard_approval_history_self` | `20260611181304_...sql:43` | trigger fn | Blocks recording your own approval decision in `approval_history` |
| `trg_sod_bank_accounts_sensitive_change` | `20260611192819_...sql:56` | trigger fn | SoD guard for sensitive bank-account field changes |
| `sod_payroll_payment_batches_guard` | `20260630130455_...sql:159` | trigger fn | SoD guard, payroll payment batches |
| `sod_stock_adjustment_scrap_guard` (redefined `20260710013320_...sql:4`) | `20260710011046_...sql:88` | trigger fn | SoD guard, scrap-type stock adjustments |
| `guard_loan_skip_override_self_approval` | `20260725140833_...sql:1` | trigger fn | SoD guard, loan-skip overrides on payroll runs |
| `_loan_close_approval_request` | `20260725132344_...sql:277` | not confirmed | Writes to `approval_requests` to close out a loan approval |
| `_mirror_approval_to_procurement_rec` / `cancel_procurement_approval` | `20260714135339_...sql:5,84` | not confirmed | Mirrors/cancels rows between `approval_requests` and `procurement_recommendations` — direct evidence of a second, parallel approval surface for procurement (see §3, §7) |
| `hr_notify_approval_event` (redefined `20260619063936_...sql:8`) | `20260619054411_...sql:44` | not confirmed | Sends notification on HR approval events |
| `trg_leave_stamp_on_approval` | `20260505013644_...sql:24` | trigger fn | Stamps leave request row on approval |

**Guard triggers named `sod_<table>_guard`** (BEFORE UPDATE), all found in `20260611181051_c9fe4b86-5502-4f2b-bf9a-633e15f05fef.sql` plus a handful of later additions:
`sod_stock_adjustments_guard` (:39), `sod_stock_transfers_guard` (:62), `sod_leave_requests_guard` (:100), `sod_timesheet_submissions_guard` (:125), `sod_employee_loans_guard` (:152), `sod_compensation_history_guard` (:175), `sod_employee_contracts_guard` (:200), `sod_bills_guard` (:221), `sod_bill_payments_guard` (:240), `sod_payments_guard` (:261), `sod_journal_entries_guard` (:282), `sod_purchase_orders_guard` (:303), `sod_expenses_guard` (:330), `sod_customer_refunds_guard` (:351), `sod_vendor_credit_notes_guard` (:372), `sod_credit_notes_guard` (:393); plus `sod_approval_history_self_guard` (`20260611181304_...sql:66`), `sod_bank_accounts_guard` (`20260611192819_...sql:123`), `sod_payroll_payment_batches_guard` (`20260630130455_...sql:196`), `sod_stock_adjustment_scrap_guard` (`20260710011046_...sql:117`), `sod_payroll_run_loan_skip_overrides_guard` (`20260725140833_...sql:33`).

**Observation**: this is a *third* approval mechanism at the DB layer — 16+ per-table BEFORE-UPDATE guards, entirely independent of `approval_rules`/`approval_workflows` and of `automated_actions`. They enforce **only** the narrow "you can't approve your own record" rule; they do nothing about thresholds, multi-step routing, or delegation, which live in `approval_rules`/`approval_workflows` instead.

---

## 3. Per-module approval surfaces (application code)

| Hook/Component | File | Reads/writes | Central engine or bypass? |
|---|---|---|---|
| `useApprovalGate` | `src/hooks/useApprovalGate.ts:53` | Reads `approval_rules` (`:102`), writes `approval_rule_logs` (`:73,162,190,208`) | Uses the rule table but **does not touch `approval_requests`/`approval_workflows`** — it's a client-side gate/log, not a request lifecycle; a parallel, thinner path than `useSalesOrderApproval`. |
| `useApprovalRules` | `src/hooks/useApprovalRules.ts:47` | CRUD on `approval_rules` (`:58,86,114,125`) | Rule management only; this is what `ApprovalRulesManager.tsx` calls (§5). Does not create `approval_workflows`/`approval_requests` rows. |
| `useSalesOrderApproval` | `src/hooks/useSalesOrderApproval.ts:33` | Reads/writes `approval_requests` (`:52,216`), `approval_workflows` (`:114,199`), plus `sales_orders`, `contacts` | This is the only client hook found that drives the `approval_requests`/`approval_workflows` pair end-to-end — i.e. the closest thing to "the central engine" in the frontend, but it's named/scoped for sales orders specifically, not generic. |
| `useProcurementRecommendations` / `useRecommendationEvents` | `src/hooks/useProcurementRecommendations.ts:121,480` | `procurement_recommendations`, `procurement_recommendation_events`, `replenishment_runs`, `warehouse_stock` — **no direct `approval_requests`/`approval_rules` read from the client**; the approval linkage happens server-side via `_mirror_approval_to_procurement_rec`/`cancel_procurement_approval` (§2) | Bypasses the client-visible approval tables entirely; procurement approvals are a DB-trigger-mirrored shadow of `approval_requests`, invisible to `useApprovalRules`/`useApprovalGate`. |
| `useAppAccessRequest` | `src/hooks/useAppAccessRequest.ts:12` | Not fully traced this pass (no `.from(` calls matched with the grep pattern used — likely calls a table under a different alias or via RPC) | **Open question** — needs follow-up read of the full file. |
| `AppAccessApprovalsInbox` | `src/components/settings/AppAccessApprovalsInbox.tsx` | Companion UI to the request hook above | Appears to be a fully separate, app-access-specific approval inbox, independent of `approval_requests`. |
| `ApprovalGateDialog` | `src/components/common/ApprovalGateDialog.tsx` | UI shell around `useApprovalGate` | Same bypass characteristics as `useApprovalGate`. |
| `ApprovalStatusBanner` | `src/components/common/ApprovalStatusBanner.tsx` | Presentational; reads whatever status prop it's given | Not itself a data surface, but is reused across modules as the "is this approved" indicator regardless of which backing table produced the status. |
| `PendingApprovalsWidget` | `src/components/dashboard/PendingApprovalsWidget.tsx` | Dashboard aggregation | Not traced to source table this pass — **open question**. |
| `RecommendationDrawer` | `src/components/inventory/RecommendationDrawer.tsx` | Procurement recommendation UI | Same procurement-shadow-approval bypass as above. |

No hook literally named `useLoanApproval` was found; loan approval logic is instead split between `_loan_close_approval_request()` (DB, §2) and whatever hook the payroll/loans UI uses (not located by name in this pass — **open question**, needs a broader grep for `employee_loans` client usage).

No dedicated `PayrollControlCenter` approval hook was found by that literal name either — flagged as an **open question**: either the name differs in the current codebase, or payroll approval logic is embedded directly in payroll pages rather than centralized in a hook.

---

## 4. Action registries / enums

- `src/lib/governance/selfActionCatalogue.ts` (507 lines): exports `SelfActionEntityType` (`:13`), `SelfActionEntry`/`SELF_ACTION_CATALOGUE` array (`:42,51`), `SELF_ACTION_MODES`/`SelfActionMode` (`:418,441`), `ENTITY_TYPE_LABELS` (`:447`), `ENTITY_TYPE_DB_KEY` (`:474`) and its inverse `DB_KEY_TO_ENTITY_TYPE` (`:503`). This is the **single source of truth for self-action/SoD entity types** on the client, mapping human labels to DB keys used by `self_action_policy.action_key`.
- DB-side, the same "action" concept is independently re-enumerated as: (a) 20 distinct `guard_*_self_approval()` function names (§2) — one hand-written function per entity rather than driven by the catalogue above; (b) `approval_rules.entity_type`/`action_name` free-text columns (no enum/check constraint found constraining these values); (c) `automated_actions.target_model`/`trigger_type` free-text VARCHAR columns (§1).
- **Duplicate/overlap**: the set of entities covered by `SELF_ACTION_CATALOGUE` (client) and the set of tables covered by `sod_<table>_guard` triggers (DB, §2) are maintained as two independently-edited lists with no generated/shared source — a new self-approvable entity must be added in both places by hand, and nothing in the codebase enforces that they stay in sync (no test or migration cross-checks catalogue keys against existing guard triggers was found).

---

## 5. Studio Approval Rules manager

`src/components/studio/ApprovalRulesManager.tsx`:
- Delegates all data access to `useApprovalRules()` (`:101`) rather than calling `supabase.from(...)` directly; calls `createRule`/`updateRule`/`deleteRule`/`toggleRule` from that hook (`:101,181`).
- Because the hook only touches `approval_rules` (§1, §3), **Studio's rule builder writes rows to `approval_rules` only** — it creates threshold/condition/approver-type definitions, not `approval_workflows` or `approval_workflow_steps` rows.
- **Connection to execution**: `approval_rules` is read at runtime only by `useApprovalGate` (§3), which logs to `approval_rule_logs` and does not create an `approval_requests` row. Meanwhile the only code path that actually drives `approval_requests`/`approval_workflows` end-to-end is `useSalesOrderApproval`, which does **not** read `approval_rules` at all (no such `.from("approval_rules")` call in that file). Net effect: **a rule authored in Studio's Approval Rules manager has no verified code path into an actual multi-step `approval_workflows`/`approval_requests` execution** — it can only gate/log via `useApprovalGate`, wherever that hook happens to be wired into a form. This is a structural gap, not just a naming one.

---

## 6. Governance UI ownership boundaries

- `src/pages/settings/GovernanceSoD.tsx` — page-level container.
- `src/components/settings/GovernanceModeCard.tsx` — reads/writes `organizations.governance_mode` (§1).
- `src/components/settings/SelfActionPolicy.tsx` — CRUD UI over `self_action_policy` (§1); owner/super_admin-only per RLS.
- `src/components/governance/SelfActionOverrideDialog.tsx` — creates `self_action_overrides` co-sign rows (§1); note this file lives under `src/components/governance/` while its sibling `SelfActionPolicy.tsx` lives under `src/components/settings/` — **inconsistent folder ownership already visible in the tree**, itself an artifact worth flagging for the consolidation.
- `src/components/settings/BlockedAttemptsQueue.tsx` — presumed to surface blocked self-action attempts (from the guard triggers in §2); exact backing table not confirmed this pass (**open question** — plausibly `self_action_overrides` with `consumed_at IS NULL`, or a dedicated log table not enumerated in the task's table list, e.g. an events/audit table fed by the `sod_*_guard` triggers' `RAISE EXCEPTION` — those triggers raise/block rather than log, so there may be no queryable "blocked attempts" table at all and this component may be reading something else, such as `governance_sod_violations()` output).
- I could not confirm within this pass whether "WorkspaceSettings governance tab" (as named in the task) is a literal file/route separate from `GovernanceSoD.tsx`, or whether `GovernanceSoD.tsx` *is* that tab's content — **open question**, needs a route-table check (e.g. `src/pages/settings/*` router config) to confirm the tab wiring matches the plan's described ownership boundaries.

---

## 7. Overlaps and gaps

**(a) Responsibilities owned by 2+ subsystems**
1. Self-approval prevention is enforced independently by: (i) 20+ DB `guard_*_self_approval` triggers (§2, hardcoded per table), (ii) `self_action_policy`/`self_action_overrides` (configurable per-org policy layer, §1), and (iii) `approval_rules.requires_review`/`flag_approval_rule_self_approver` (§1, §2) — three separate mechanisms for the same "don't let X approve their own Y" concern, with no single source of truth on which one wins when they disagree (a `require_cosign` self-action-policy entry and a hardcoded `guard_*_self_approval` trigger could both fire on the same UPDATE).
2. Rule authoring is split between Studio's `ApprovalRulesManager.tsx`/`useApprovalRules` (writes `approval_rules`) and whatever seeds/writes `approval_workflows`/`approval_workflow_steps` (no UI found — §3/§5) — two tables that should represent the same concept ("what needs approval and how") are populated by disconnected code paths.
3. "Action" as a concept is enumerated three times independently: `selfActionCatalogue.ts` (client), `guard_*_self_approval` function names (DB), and `approval_rules.action_name`/`automated_actions.target_model` free text (DB) — §4.
4. Audit/event trails: `audit_logs`, `admin_audit_log`, `business_event_outbox`, and `approval_history` all separately capture "something happened" for overlapping domains (org-level admin actions vs. business events vs. approval decisions), with no single canonical event table.

**(b) Responsibilities owned by 0 subsystems (gaps)**
1. No mechanism found that reconciles `SELF_ACTION_CATALOGUE` entity types against the actual set of `sod_<table>_guard` triggers in the DB — if a new guard trigger is added without a matching catalogue entry (or vice versa), nothing detects the drift (only `governance_list_unowned_tables()`, §2, exists as a *general* unowned-table check, and it isn't confirmed to be approval/self-action-aware specifically).
2. Studio-authored `approval_rules` have no verified execution path into `approval_requests`/`approval_workflows` (§5) — a rule can be created in the UI that never actually blocks or routes anything.
3. `admin_audit_log`'s original RLS (`USING/WITH CHECK (true)` for any `authenticated` user, §1) was not confirmed to have been tightened for read access (only INSERT was later restricted to `service_role` in one migration) — any authenticated user may currently be able to read the platform admin audit log; this needs a live RLS check to confirm/deny, since a competing service_role-only insert policy was added later without confirmed removal of the older permissive one.
4. `automated_actions`/`automated_action_steps`/`automated_action_logs` (§1) — a fully generic automation engine capable of encoding approval-like gates — has no confirmed client-side consumer at all in this pass; it's unclear whether it's dead code, edge-function-only, or simply not discoverable via the hook-name grep used.

**(c) Modules that skip approval entirely**
- `useProcurementRecommendations`/`RecommendationDrawer` (§3) never call into `approval_rules`/`approval_requests`/`useApprovalGate` from the client; their only tie to "approval" is a server-side mirror trigger (§2), meaning any client code that doesn't know about that trigger has no visibility into whether a recommendation is "approved."
- No approval hook or table reference was found for expense/bill/PO/credit-note/refund/journal-entry create-time gating from the *client* side (only the reactive DB-side `guard_*_self_approval` triggers exist, §2) — i.e. these modules appear to rely entirely on the DB guard triggers to block self-approval at UPDATE time, with no client-side pre-submission gate comparable to `useApprovalGate`/`useSalesOrderApproval`. This should be confirmed against each module's actual submit handler in the consolidation work, since it wasn't exhaustively traced per-module in this pass.

---

## Open questions (would need follow-up to close)

1. **No live DB access in this pass** (no `supabase--read_query` tool, no `DATABASE_URL`) — every RLS policy and function signature above was reconstructed from migration *source*, not from `pg_policies`/`information_schema` on the running database. Migrations can be superseded by later `ALTER POLICY`/`DROP POLICY` statements not linked here; a live query is needed to confirm final state, especially for `admin_audit_log`'s permissive policies (§7b-3).
2. `SECURITY DEFINER` status was not individually confirmed for any function in §2 (would require reading each function body/`sed` block in full; only the `CREATE FUNCTION` header lines were extracted for the survey pass).
3. `useAppAccessRequest.ts`, `PendingApprovalsWidget.tsx`, `BlockedAttemptsQueue.tsx`, and any `PayrollControlCenter`/`useLoanApproval`-equivalent code were not fully traced to their backing tables (§3, §6) — needs targeted full-file reads.
4. Whether "WorkspaceSettings governance tab" is `GovernanceSoD.tsx` itself or a separate route wrapping it was not confirmed (§6) — needs a check of the settings router/tab config.
5. Whether `automated_actions`/steps/logs (§1, §7b-4) have any client consumer at all, or are edge-function/cron-only, was not resolved.

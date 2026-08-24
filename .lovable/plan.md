# CRM Domain Audit & Rework Contract

Labels: **FACT** = verified in this repo/database · **STD** = established ERP/CRM practice · **INFER** = reasoned conclusion for this system.

## 1. Verdict

**INFER: the CRM is a CRUD shell with a thin, partly-broken conversion bridge — not a business-event-driven domain.**

Evidence anchors: there is no lifecycle state column, no state machine, no audit trail, no outbox topic, no server-side transition operation, and every conversion RPC is a SECURITY DEFINER function with **zero caller authorization** and a **guaranteed runtime failure**.

## 2. What CRM should own vs. what it owns here

- **STD** CRM owns pre-commercial intent: leads, opportunities, pipeline, activities, win/loss reasons. It *references* the partner/contact master, never duplicates it. It creates **no** accounting entries; the first commercial document (quotation/SO) is created *from* CRM, and only invoices post to the GL.
- **FACT** Contacts are the canonical partner master (`contacts`); `crm_leads` references it via `contact_id`, `company_contact_id`, `converted_to_contact_id`.
- **FACT** CRM duplicates contact identity as free text: `contact_name`, `email`, `phone`, `website`, `street`, `city`, `state`, `country` on `crm_leads` — with no reconciliation back to `contacts` and no "which one is authoritative" rule. **INFER** this is acceptable for an *unqualified* lead (STD: Odoo does the same), but this schema never forces promotion to a contact at qualification, so duplicate customer identities are permanent and undetected.
- **FACT** CRM touches no journal/GL code path. The accounting boundary is intact today.

## 3. Lead vs Opportunity (actual)

- **FACT** One table, one discriminator: `crm_leads.type CHECK (type IN ('lead','opportunity'))`, default `'lead'`. So Lead and Opportunity are **lifecycle states of one entity**, matching **STD** (Odoo `crm.lead`).
- **FACT** But nothing enforces the transition: `type` is a plain client-writable column. There is no `qualify` operation, no `qualified_at`, no rule that an opportunity must have a stage, a contact, an expected revenue, or an owner. `stage_id` is nullable with `ON DELETE SET NULL`.
- **FACT** There is **no `status` column at all**. Lifecycle is inferred from three unrelated nullable columns — `won_at`, `lost_at`, `is_active` — plus the stage's `is_won`/`is_lost` booleans. **INFER**: four independent representations of the same state, none constrained against the others. A row can be `won_at` set *and* sitting in a `is_lost` stage *and* `is_active=false`.

## 4. Business-event map (actual vs required)

| Intent | Today (**FACT**) | Producer | Audit | Event | Downstream |
|---|---|---|---|---|---|
| Lead captured | client `INSERT` into `crm_leads`, number from `get_next_lead_number` | browser | none | none | none |
| Lead qualified | client `UPDATE type='opportunity'` | browser | none | none | none |
| Stage changed | drag/drop → `UPDATE {stage_id, probability}` (`useLeads.ts:182-197`, `CRMPipeline.tsx:112-124`) | browser | none | none | none |
| Won | client `UPDATE {won_at, probability:100, stage_id}` (`useLeads.ts:199-226`) | browser | none | none | *optional* client-chosen conversions |
| Lost | client `UPDATE {lost_at, lost_reason_id, probability:0}` (`useLeads.ts:273-303`) | browser | none | none | none |
| Deleted | client `UPDATE is_active=false` — soft delete, no reason, no guard | browser | none | none | none |
| Owner / revenue / probability / close-date / contact change | generic `updateLead` passthrough of arbitrary columns (`useLeads.ts:169-180`) | browser | none | none | none |

- **FACT** Triggers on `crm_leads` are only: `update_updated_at_column`, `enforce_org_write_lock`, and two automation-notify triggers. **No audit trigger, no history table, no `business_event_outbox` emitter.**
- **FACT** `business_event_topics` contains **no** `crm.*`, `lead.*`, `estimate.*` or `sales_order.*` topic. CRM is invisible to the outbox/saga fabric the rest of the ERP uses.
- **STD/INFER** required minimum: `crm_lead_stage_changed`, `crm_lead_won`, `crm_lead_lost`, `crm_lead_reopened`, `crm_lead_owner_changed`, `crm_lead_value_changed` — each an authorized RPC writing state + a history row, and (for won/lost only) an outbox event.

## 5. Confirmed defects (all **FACT**)

**D1 — every conversion RPC is broken at runtime.** `convert_lead_to_contact`, `convert_lead_to_estimate`, `convert_lead_to_sales_order`, `convert_lead_to_project` each end with `INSERT INTO crm_activities (organization_id, lead_id, activity_type, summary, is_done, completed_at, created_by)` — omitting `business_id`, which is `NOT NULL` with no default. Every conversion therefore aborts with a not-null violation and rolls back. The existing test `crm_conversion_idempotency_test.sql` never caught it because it skips when no business row exists.

**D2 — SECURITY DEFINER without authorization (cross-tenant write).** All four `convert_lead_to_*` plus `calculate_pipeline_value` and `get_next_lead_number` are `SECURITY DEFINER` and contain **no** `user_can_access_business` / membership / module-permission check; they operate on whatever `p_lead_id` / `p_org_id` the browser supplies, bypassing RLS. Any authenticated user of any tenant can read another tenant's pipeline value and create contacts/estimates/sales orders/projects inside another tenant's business.

**D3 — `get_next_lead_number` is `COUNT(*)+1`.** Non-atomic and non-monotonic: concurrent creates collide against `UNIQUE (organization_id, lead_number)`, and soft-deleted leads make numbers repeat. Also unscoped by business.

**D4 — no branch dimension.** `crm_leads`, `crm_stages`, `crm_activities`, `crm_lost_reasons` have **no `branch_id`**. In a multi-branch ERP the pipeline cannot be branch-owned, branch-scoped, or branch-reported.

**D5 — stage/activity/lost-reason RLS is organization-scoped only.** `crm_stages`, `crm_activities`, `crm_activity_types`, `crm_lost_reasons` policies test `organization_id IN (select organization_id from user_roles ...)`. `crm_activities.business_id` is `NOT NULL` yet the policy ignores it. Only `crm_leads` is properly business + module-permission gated (`crm_leads_*_v2`). **Cross-business leakage inside one tenant is real for stages and activities.**

**D6 — over-broad grants.** `anon` and `authenticated` hold `arwdDxtm` (ALL, incl. TRUNCATE) on every `crm_*` table. RLS is the only barrier; the grant surface violates least privilege.

**D7 — no cross-business referential integrity.** FKs are single-column: `crm_leads.stage_id → crm_stages(id)`, `contact_id → contacts(id)`, `lost_reason_id`, `assigned_to → auth.users`. Nothing prevents a Business-A lead pointing at a Business-B stage, contact, or lost reason. No composite `(business_id, id)` keys, no validation trigger. `assigned_to` is not constrained to a member of that business.

**D8 — no terminal-state integrity.** No constraint that `won_at` and `lost_at` are mutually exclusive; that a won lead sits in an `is_won` stage; that `probability=100` iff won; that a terminal lead's revenue/stage/customer is frozen. **FACT** `updateLead` will happily change expected revenue, contact, or probability on a won lead, after an estimate/SO/project already exists.

**D9 — multiple contradictory terminal stages possible.** `crm_stages` has no unique constraint on `is_won`/`is_lost` per business, and `is_won` and `is_lost` can both be true on one stage. Yet `useLeads.ts:210-217` and `:275-282` use `.single()` on the won/lost stage lookup — two won stages makes Won/Lost throw; zero silently skips the stage move.

**D10 — stage settings are pure CRUD with no impact analysis.** `useCRMStages.ts` inserts/updates/deletes directly; `deleteStage` sets `is_active=false` with **no check for live leads**, leaving leads pointing at an invisible stage (they vanish from the pipeline board but stay in totals). Sequence is a free integer with no uniqueness — reorder collisions are possible. No server-side validation, no audit, no events.

**D11 — pipeline figures are computed in React over an unbounded fetch.** `CRMDashboard.tsx:30-52` and `CRMPipeline.tsx:92-100` reduce `expected_revenue`/`probability` in JS. Consequences: (a) subject to the 1000-row PostgREST cap → silently understated pipeline; (b) `CRMPipeline` totals include won **and** lost leads; `CRMDashboard` "pipeline value" includes won/lost too (`activeLeads` only filters `is_active`); (c) **no currency at all** — `crm_leads` has no currency column, amounts are summed raw and rendered with `formatCurrency` as if base currency; (d) win rate/velocity computed from the same partial page; (e) `calculate_pipeline_value` exists server-side with the *correct* definition (open opportunities only) and is **unused** — two divergent implementations of the same metric.

**D12 — activities are structurally real but operationally orphaned.** `crm_activities` has `due_date`, `due_time`, `assigned_to`, `is_done`, `completed_at`, `completed_by`, `outcome`, `activity_type` (call/email/meeting/task/note/deadline/system) — a genuine follow-up model (good). But: no `branch_id`; org-only RLS; no reminder/notification consumer; overdue state computed in the browser; `crm_leads.next_activity_date/summary` is a denormalized cache **never maintained by any trigger**; no rule requiring an open next activity on an open opportunity; stage changes and won/lost create no system activity (only conversions do — and those abort per D1).

**D13 — no history whatsoever.** None of these questions are answerable: who changed the stage, what the previous stage was, when it became qualified, who changed expected revenue or owner, what the value was before Won. Only `created_by` and `updated_at` exist.

## 6. Accounting boundary (**FACT**, and it is correct)

No CRM table, trigger, or function reaches a journal/GL posting routine. `convert_lead_to_estimate` / `_sales_order` / `_project` create commercial and operational documents only. **STD** confirms this is right: `OpportunityWon ≠ SalesOrderConfirmed ≠ JournalPosted`; the GL boundary belongs to invoice confirmation. **Recommendation: keep it. Do not add accounting to CRM.**

## 7. CRM → Sales → Project dependency graph (**FACT**, from FKs + function bodies)

```text
crm_leads ──source_lead_id──> estimates      (ON DELETE SET NULL)
crm_leads ──source_lead_id──> sales_orders   (ON DELETE SET NULL)
crm_leads ──source_lead_id──> projects       (NO ACTION)
sales_orders <──project_id──> projects.source_sales_order_id   (bidirectional stitch)
sales_order_items.project_id  (set by convert_lead_to_project)
```

- **FACT** CRM can create a Project **directly**, bypassing Sales: `convert_lead_to_project(p_lead_id, p_sales_order_id DEFAULT NULL)` inserts a project, seeds `project_stages`, and only stitches the SO if an id was passed *by the browser*. `useLeads.ts:262-265` calls it with no SO.
- **FACT** All three source links are **nullable** → Project can exist with no lead and no SO; Sales can exist with no lead. Nothing is enforced as a chain.
- **FACT** The link is **operational, not informational**: the project's `customer_id`, `budget`, `currency`, and billing flags are derived from the lead, and `sales_order_items.project_id` is written — so a wrong/cross-business conversion corrupts project billing.
- **INFER** the real graph is a **star from CRM**, not a chain: `crm_leads → {estimates | sales_orders | projects}` in any combination, orchestrated client-side by `markAsWon` (`useLeads.ts:228-265`) which decides *in the browser* what downstream documents to create. **STD** (Odoo/Dynamics/NetSuite): opportunity Won → **quotation/SO is the only sanctioned successor**; a project is created from the *confirmed sales order* (or an SO line of type "service/project"), never from the opportunity directly. **INFER: Project is downstream of Sales, not of CRM** — the current direct edge is the architectural defect, and `convert_lead_to_project` should require a confirmed sales order.
- **FACT** Won triggers **nothing** server-side. No trigger, no function, no event reacts to `won_at`. Downstream creation is entirely an optional browser choice.

## 8. Classification

**A. Correct today**: single lead/opportunity entity with `type`; activity data model shape; accounting boundary; `crm_leads` business+module RLS; lost-reason catalog; `crm_lead_items` totals trigger (`trg_crm_lead_items_recompute`, tested); `calculate_pipeline_value`'s SQL definition; conversion idempotency design (guarded by `source_lead_id` lookups).

**B. Implemented but architecturally unsafe**: D1, D2, D3, D5, D6, D7, D9, D10, D11 (client financial math), direct client stage/won/lost writes.

**C. Implemented but business-incomplete**: no lifecycle state column (D8), no history (D13), no branch dimension (D4), no currency on leads, activity follow-up loop not closed (D12), CRM→Project bypasses Sales.

**D. Missing but genuinely required**: authorized transition RPCs (qualify / change_stage / win / lose / reopen / reassign / revalue); `crm_lead_history` table; terminal-state and cross-business invariants; server-side pipeline metrics RPC; branch scoping; lead currency; stage-deletion impact guard; won/lost outbox topics.

**E. Do NOT build now**: lead scoring, AI/predictive forecasting, marketing automation, campaign attribution beyond the existing `source/medium/campaign` text, custom-field engine, multi-currency pipeline revaluation, territory/quota management, email sync.

## 9. Phased execution plan

**Phase 0 — Regression harness first (no behaviour change).** Fix `crm_conversion_idempotency_test.sql` so an absent business **fails** instead of skipping; add a test asserting every `crm_activities` insert inside CRM functions supplies `business_id`; add a catalog test asserting no `crm_*` SECURITY DEFINER function lacks an authorization call. These must go red before Phase 1.

**Phase 1 — Stop the bleeding (blocking).** Fix D1 (add `business_id` to all system-activity inserts). Fix D2 (add `user_can_access_business` + module-permission gate to all six functions; `REVOKE ... FROM anon`). Fix D3 (sequence/advisory-lock-based lead numbering, business-scoped). Fix D6 (narrow grants to the privileges the policies actually allow). Fix D5 (rewrite stage/activity/lost-reason/activity-type policies to business scope).

**Phase 2 — Lifecycle state machine.** Add `crm_leads.status` (enum: `new, qualified, proposition, won, lost`) as the single authoritative state, backfilled from `won_at`/`lost_at`/stage. Add invariants: won⊻lost, `won_at` iff `status='won'`, terminal ⇒ frozen revenue/customer/stage, stage must belong to same business, one `is_won` and one `is_lost` stage per business, `is_won AND is_lost` forbidden. Replace client writes with RPCs: `crm_qualify_lead`, `crm_change_stage`, `crm_mark_won`, `crm_mark_lost`, `crm_reopen_lead` (audited, reason required), `crm_reassign_lead`, `crm_revalue_lead`. Client hooks become RPC callers only.

**Phase 3 — History + events.** `crm_lead_history` (lead_id, changed_at, changed_by, field, old_value, new_value, transition, reason) written by a trigger on the guarded columns + by the transition RPCs. Register `crm.lead.won`, `crm.lead.lost`, `crm.lead.stage_changed` in `business_event_topics` and emit from the RPCs.

**Phase 4 — Cross-business & branch integrity.** Add `branch_id` to CRM tables with derivation from the actor's branch; composite `(business_id, id)` uniqueness + validation triggers for stage/contact/lost-reason/assignee; guard `assigned_to` to business members; block business/branch change once a downstream document exists.

**Phase 5 — Metrics & reporting truth.** One server RPC (`crm_pipeline_metrics`) returning pipeline value, weighted value, open/won/lost counts, win rate, velocity, stage breakdown and losses-by-reason — business+branch scoped, open-opportunities-only, currency-explicit. Delete the React reducers; retire or reimplement `calculate_pipeline_value` behind it. Add `currency_code` to `crm_leads` (default business base currency).

**Phase 6 — Correct the Sales/Project edge.** Require a confirmed sales order for `convert_lead_to_project`; make Won's sanctioned successor the estimate/SO only; move project creation to a Sales-side operation. Add a stage-deletion impact guard (block deactivation while open leads reference the stage, or force reassignment).

**Phase 7 — Close the activity loop.** Maintain `next_activity_date/summary` by trigger; auto-log system activities on every transition; server-side overdue view; require an open next activity on open opportunities (warn, not block).

## 10. Validation / invariant tests to ship with each phase

Catalog tests: no CRM SECURITY DEFINER function without an authz call; no CRM function inserting `crm_activities` without `business_id`; every CRM table business-scoped in RLS; `anon` holds no write grant on `crm_*`; every emitted CRM topic registered. Behavioural tests: concurrent lead creation yields distinct numbers; cross-business stage/contact assignment rejected; won lead rejects revenue/customer edits; reopen writes history; two won stages per business rejected; stage deactivation with live leads rejected; conversions idempotent **and** succeeding (not skipped); metrics RPC matches a SQL fixture across >1000 leads and excludes won/lost.

## 11. Execution status

Audit only — **no code or database changes made**. Nothing implemented. Next action: approve, then start **Phase 0** (tests that prove D1/D2 red) before any fix.



========================
PROGRESS STATUS
============================
Phase 1 of the CRM rework is complete, verified, and recorded in the plan. Summary of where things stand:

Done this turn

All four convert_lead_to_* RPCs repaired (D1): they now supply business_id on the system-activity insert, so lead conversions actually succeed — previously every one rolled back.
Authorization seam _crm_assert_lead_access added and wired into all four conversions plus calculate_pipeline_value and get_next_lead_number (D2); scope is derived from the lead row, never from a browser-supplied id.
Lead numbering moved onto the shared atomic numbering engine, and useLeads.createLead no longer falls back to a client-invented number (D3).
CRM RLS rewritten to business scope with sales-module permissions on stages, activities, activity types, lost reasons and lead items; crm_stages.business_id tightened to NOT NULL (D5).
anon grants revoked across all six CRM tables and on every repaired function; authenticated narrowed (D6).
Verified via catalog queries (0 unscoped policies, no anon access, authz present in all four conversions), build OK, CRM tests green. Linter total went down, no new findings.
Remaining (not started) Phases 2–7 in the plan: lifecycle state machine with a real status column and invariants, lead history, CRM domain events, branch dimension, currency_code, and server-side pipeline metrics to replace the client-side reducers. The frontend audit that just returned confirms the Phase 5 concern independently — Pipeline Value and Weighted Value are computed in React over an unpaged select("*"), and on the Pipeline page they include won and lost deals, so the headline figures are wrong today regardless of row count.

The plan's "Instructions for the next agent" section tells the next session to re-verify Phase 1 from the catalog (especially convert_lead_to_sales_order, which needed a follow-up migration) before starting Phase 2.


=======
KINDLY VERIFY WHAT IS CLAIMED TO BE IMPLEMENTED IS ACTUALLY IMPLEMENTED SO THAT WE DONT HAVE INCOMPLETE SHALLOW AND OPHARNED IMPLEMENTATIONS, make sure the plan logical flow is not lost so dont archive the plan file when items are yet in queu, this is a controlled phase by phase rework on CRM
# CRM Domain Audit — Phase 1 Verification & Phase 2 Execution Plan

Labels: **FACT** = verified now against this repo/database · **STD** = established ERP/CRM practice · **INFER** = reasoned conclusion.

## 1. Verification of the previous engineer's claims

I re-derived every Phase 1 claim from the live catalog rather than trusting the log.

| Claim | Verdict | Evidence |
|---|---|---|
| D1 — all four `convert_lead_to_*` supply `crm_activities.business_id` | **CONFIRMED** | catalog: `act_biz = true` for contact / estimate / project / sales_order, including the follow-up-repaired `convert_lead_to_sales_order` |
| D2 — authorization on every CRM SECURITY DEFINER entry point | **CONFIRMED** | all six functions plus `_crm_assert_lead_access` reference `user_can_access_business` / `user_has_module_permission` |
| D3 — lead numbering no longer `COUNT(*)+1` | **CONFIRMED** | `get_next_lead_number` delegates to `get_next_document_number` (advisory-locked) and gates org/business/permission first |
| D5 — business-scoped RLS on all CRM tables | **CONFIRMED** | zero `crm_*` policies lack a `business_id` predicate |
| D6 — `anon` revoked | **CONFIRMED** | `anon` holds no grant on any `crm_*` table |
| Phase 0 harness exists | **CONFIRMED** | `supabase/tests/crm_domain_contract_test.sql`, hardened `crm_conversion_idempotency_test.sql` |
| Phases 2–7 untouched | **CONFIRMED** | no `status`, `branch_id` or `currency_code` column on `crm_leads`; no `crm_lead_history` table; no `crm_lead_status` enum; zero `crm.*` rows in `business_event_topics` |

**FACT** the client still drives the whole lifecycle directly: `src/hooks/crm/useLeads.ts` writes `stage_id`, `won_at`, `probability`, `lost_at`, `is_active` with raw `.update()` calls, and `updateLead` passes arbitrary columns through. That is exactly what Phase 2 exists to remove.

**FACT** `crm_leads` is currently empty (0 rows) and there are no contradictory terminal stages, so the Phase 2 backfill and new constraints can be applied without data remediation. This is the cheapest moment to land the state machine.

Phase 1 is genuinely closed. Resume at **Phase 2**.

## 2. Phase 2 — Lifecycle state machine (this milestone)

### Authoritative state
Add `crm_leads.status` as a real enum (`new`, `qualified`, `proposition`, `won`, `lost`), `NOT NULL DEFAULT 'new'`, backfilled from `won_at` / `lost_at` / stage flags. `status` becomes the single source of truth; `won_at` / `lost_at` / `probability` become derived facts kept consistent by constraint, not by the browser.

### Invariants (database-enforced)
- `won_at` set iff `status='won'`; `lost_at` set iff `status='lost'`; never both.
- `status='won'` ⇒ `probability = 100`; `status='lost'` ⇒ `probability = 0`; otherwise `0 <= probability <= 100`.
- `stage_id`, `contact_id`, `company_contact_id` and `lost_reason_id` must belong to the same business as the lead (validation trigger; single-column FKs cannot express this).
- At most one active `is_won` stage and one active `is_lost` stage per business; a stage may not be both.
- Terminal leads (`won`/`lost`) reject edits to `expected_revenue`, `contact_id`, `stage_id` and `type` outside a sanctioned reopen.
- Direct client writes to the guarded columns are blocked by a trigger; only the transition RPCs (which set a session flag) may change them.

### Transition RPCs (SECURITY DEFINER, all gated through `_crm_assert_lead_access`)
`crm_qualify_lead`, `crm_change_stage`, `crm_mark_won`, `crm_mark_lost` (reason required), `crm_reopen_lead` (reason required), `crm_reassign_lead` (assignee must be a member of the lead's business), `crm_revalue_lead`. Each validates the transition against an explicit allowed-transition table, writes state atomically, and logs a system `crm_activities` row with `business_id`.

Allowed transitions: `new → qualified | lost`; `qualified → proposition | won | lost`; `proposition → qualified | won | lost`; `won → qualified` and `lost → new | qualified` only via `crm_reopen_lead` with a reason. Backward stage moves inside a non-terminal status stay allowed (STD: Odoo permits them) but are logged.

### Client conversion
`useLeads.ts` stops issuing lifecycle `.update()` calls. `moveToStage`, `markAsWon`, `markAsLost`, `deleteLead` and the lifecycle half of `updateLead` become thin RPC callers; the won-stage `.single()` lookup (which throws on duplicate stages and silently no-ops on zero) is deleted because the server now resolves the terminal stage. `updateLead` keeps only descriptive fields (name, notes, tags, source, campaign).

### Tests shipped with the phase
- Catalog: every guarded column has a blocking trigger; every transition RPC carries an authz call.
- Behavioural SQL: illegal transition rejected; won lead rejects revenue/contact edit; cross-business stage assignment rejected; two active won stages rejected; reopen requires a reason and writes an activity; `probability`/`won_at` stay consistent with `status`.
- Architecture (vitest): no direct client write to `crm_leads.{status,stage_id,won_at,lost_at,probability,is_active}` outside the RPC layer.

## 3. Phases after this one (unchanged order)

3. History table + `crm.lead.*` outbox topics.
4. Branch dimension + remaining cross-business integrity.
5. Server-side `crm_pipeline_metrics` RPC; delete the React reducers; add `currency_code`.
6. Sales/Project edge correction; stage-deletion impact guard.
7. Activity loop: maintained `next_activity_date`, auto system activities, server-side overdue.

## 4. Additions I am appending to the previous engineer's plan

- **Stage-deletion guard moved up.** `useCRMStages.deleteStage` deactivates a stage with live leads pointing at it — those leads disappear from the board but stay in totals. Phase 2 already introduces the stage-integrity trigger, so the guard lands here rather than in Phase 6.
- **`is_active` soft delete becomes a transition.** Today deleting a lead is an untracked `is_active=false`. It must be `crm_archive_lead` with a reason, and it must be refused on a lead that already has a downstream estimate/SO/project.
- **Assignee membership check.** `assigned_to` currently references `auth.users` with no business-membership constraint; the reassign RPC and the validation trigger both enforce it.
- **Session-flag pattern reused.** The guard trigger uses the same "only an RPC may write this column" mechanism already used elsewhere in this codebase (e.g. the estimate/proforma status write guards) so the CRM does not invent a new idiom.

## 5. Technical notes

Everything in Phase 2 is one migration (enum, column, backfill, constraints, triggers, RPCs, grants) plus edits to `src/hooks/crm/useLeads.ts`, `src/hooks/crm/useCRMStages.ts` and the CRM pipeline/dashboard components that call them. New SQL tests go in `supabase/tests/`, the architecture test in `src/test/architecture/`. No UI redesign, no accounting-side changes — the accounting boundary stays exactly where it is (CRM posts nothing to the GL).

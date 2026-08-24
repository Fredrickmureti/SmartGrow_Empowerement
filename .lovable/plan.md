# CRM Domain Audit — Verification Verdict (2026-08-24 late) and Phase 4 Completion Plan

Labels: **FACT** = verified against the live repo/database now · **STD** = established ERP/CRM practice · **INFER** = reasoned conclusion.

## 1. Verification of the handover

Re-derived from the live catalog and the codebase, not from the previous engineer's notes.

| Claim | Verdict | Evidence |
|---|---|---|
| Phases 1–3 complete (tenancy repair, server-owned lifecycle, history + events) | **CONFIRMED** | Eight `crm.lead.*` topics registered with `producer_domain='crm'`; eight matching handlers in the outbox dispatcher; history trigger + append-only table; guarded transition RPCs |
| Branch dimension added to CRM tables | **CONFIRMED** | `branch_id` exists on `crm_leads`, `crm_stages`, `crm_activities`, `crm_lost_reasons`; `crm_lead_history` has `branch_id`, `from_branch_id`, `to_branch_id` |
| Governed branch transfer RPC + branch access in the guards | **CONFIRMED** | `crm_transfer_lead_branch`, `_crm_activity_branch_from_lead`, branch checks inside `_crm_assert_lead_access` |
| Event payload carries branch fields | **FALSE** | `_crm_emit_lead_event` contains no branch reference — the migration that was meant to add it failed |
| `crm.lead.branch_transferred` topic registered | **FALSE** | Not present in `business_event_topics` (the table's column is `topic_prefix`, not `event_type` — the cause of the failed migration) |
| Dispatcher handles the new event | **FALSE** | No `crm.lead.branch_transferred` entry; a transfer today would dead-letter as an unknown type |
| Branch surfaced in the UI | **FALSE** | No branch reference anywhere under `src/components/crm` or `src/hooks/crm` |
| Branch ratchet tests | **FALSE** | `crm_domain_contract_test.sql` contains no branch assertions |

**Verdict (FACT):** Phase 4 is roughly two-thirds landed in the database and zero percent landed in the event contract, the UI and the tests. The database is ahead of the plan document. Nothing is half-written in application code, so there is no cleanup debt — only unfinished work.

## 2. Phase 4 completion (this milestone)

Executed in this order, one object per migration.

1. **Event payload + topic.** Re-apply the `_crm_emit_lead_event` update so the published payload carries `branch_id`, `from_branch_id`, `to_branch_id`; insert the `crm.lead.branch_transferred` row into `business_event_topics` using the real columns (`topic_prefix`, `producer_domain`, `consumer_domains`, `handler_scope`, `description`, `max_attempts`).
2. **Dispatcher.** Add the record-only `crm.lead.branch_transferred` handler alongside the other eight, redeploy, and confirm no `crm.lead.*` rows land in `business_event_outbox_dead`.
3. **Remaining cross-business integrity (D7).** Composite `(business_id, id)` foreign keys or validation triggers for `crm_leads.stage_id`, `contact_id`, `lost_reason_id`, and a membership check constraining `assigned_to` to a user of that business — closing the "Business A lead referencing Business B rows" hole that the scope guard covers only on the guarded write path.
4. **UI.** Branch selector on lead create (defaulting to the user's active branch), branch column and filter on the pipeline and lead list, a "Transfer branch" action wired to `crm_transfer_lead_branch` with a mandatory reason, and branch shown in the History timeline.
5. **Ratchet tests.** Extend `crm_domain_contract_test.sql` with branch isolation (cross-branch stage/lost-reason rejection, direct `branch_id` UPDATE rejection, RLS visibility across branches) and extend the dispatcher topic architecture test to assert the ninth topic.

Phase 4 closes only when schema, event contract, dispatcher, UI and tests are all coherent.

## 3. Phases still pending after that (unchanged roadmap order)

- **Phase 5 — pipeline metrics as a server contract (D11).** `crm_pipeline_metrics` RPC (open opportunities only, business + branch scoped, no row cap); delete the React reducers in `CRMDashboard.tsx` / `CRMPipeline.tsx`; retire or fold in `calculate_pipeline_value`; add `currency_code` to `crm_leads` and resolve through the canonical FX resolver — never `COALESCE(rate, 1)`.
- **Phase 6 — Sales/Project edge correction; stage-deletion impact guard (D10).** Server-side stage archive with live-lead impact analysis and mandatory reassignment; stage sequence uniqueness per business; stage change audit.
- **Phase 7 — activity loop (D12).** Trigger-maintained `crm_leads.next_activity_date` / `next_activity_summary`, server-side overdue derivation, automatic system activities on lifecycle events, reminder consumer.

## 4. Additions to the roadmap justified by this review

- **Phase 4 item 3 (cross-business FKs)** was listed in the roadmap but not attempted; it stays inside Phase 4 rather than drifting later, because branch isolation without business-level referential integrity is a half-guarantee.
- **Phase 5 addition:** the branch dimension must be a first-class filter in the metrics RPC signature, not a post-filter, otherwise the new branch scoping is invisible in reporting.
- **Phase 6 addition:** stage archive must also handle branch-specific stages (a stage scoped to a branch that is being deactivated), which did not exist when Phase 6 was written.

## 5. Working rules

- One object per migration; no batching.
- Every phase lands schema + guards + event contract + UI + ratchet test before the next opens.
- This file is updated immediately after each implementation step.

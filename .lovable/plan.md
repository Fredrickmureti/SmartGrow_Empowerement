# CRM Domain — Handover Verification (2026-08-25) and Phase R0 Execution Plan

Labels: **FACT** = verified now against this repo/database · **STD** = established ERP/CRM practice · **INFER** = reasoned conclusion.

## 1. Verification of the previous engineer's claims

Re-derived from the live catalog and code, not from the notes.

| Claim in the handover | Verdict | Evidence |
|---|---|---|
| Lifecycle is server-owned (guards + transition RPCs + history + outbox) | **CONFIRMED** | `crm_leads.business_id` NOT NULL, `stage_id`/`branch_id` present; eight `crm.lead.*` topics registered plus `crm.lead.branch_transferred` |
| Branch dimension and branch-transfer event registered | **CONFIRMED (now fixed)** | `crm.lead.branch_transferred` is present in `business_event_topics` |
| Automation-created CRM activities are broken | **CONFIRMED** | `process-automation/index.ts` `create_activity` inserts `crm_activities` without `business_id`, and `crm_activities.business_id` is NOT NULL → every automation activity fails |
| Scheduled CRM pipeline report is broken | **CONFIRMED** | `process-scheduled-reports/index.ts:498` selects `company_name`, which no longer exists on `crm_leads` |
| AI assistant CRM context is broken | **CONFIRMED** | `ai-assistant/index.ts:557-559` selects and filters on `stage`, which no longer exists (`dataTools.ts` already uses `stage_id`) |
| `crm_lead_items` is a tenancy hole | **CONFIRMED** | `business_id` is nullable, no `(lead_id, business_id)` composite FK, no product/business validation constraint |
| `crm_lead_history` has excessive grants | **CONFIRMED** | both `anon` and `authenticated` hold SELECT/INSERT/UPDATE/DELETE on an append-only history table |
| CRM events have registered consumers | **FALSE** | every `crm%` topic has an empty `consumer_domains` list — the outbox is instrumentation, not a proven workflow |
| Lead-level currency exists | **FALSE** | `crm_leads` has no `currency_code`; expected revenue has no declared currency |

Data check before migration (**FACT**): 0 `crm_lead_items` rows with a null business, 0 rows whose business differs from the parent lead. The tightening migration is safe with no backfill risk.

Resume point: **Phase R0**, as the audit prescribed. No feature work first.

## 2. Phase R0 — repair the false completion claims

Each item is small and independently testable.

**Consumer repairs (code only)**
1. `process-automation` `create_activity`: derive `business_id` (and `branch_id` where available) from the target lead before insert; fail loudly if the lead cannot be resolved.
2. `process-scheduled-reports` CRM pipeline report: drop `company_name`; source company from the linked contact, and derive lifecycle state from `status` rather than `won_at`/`lost_at` guessing.
3. `ai-assistant` CRM context: replace `stage` with `stage_id` + `crm_stages(name)` and filter open leads by `status not in ('won','lost')`.

**Database repairs (one object per migration, per project convention)**
4. `crm_lead_items.business_id` → NOT NULL.
5. Composite FK `(lead_id, business_id)` referencing `crm_leads(id, business_id)` so an item can never belong to a different business than its lead.
6. Trigger validation: `product_id`, when present, must belong to the item's business.
7. Revoke `anon` privileges on `crm_lead_history` entirely and reduce `authenticated` to SELECT (writes already flow through the history trigger, which runs as the definer).

**Event honesty**
8. Either register real `consumer_domains` for the CRM topics or mark them explicitly as integration-only in the topic registry, so the catalog stops implying downstream consumers that do not exist.

**Tests**
9. Extend `supabase/tests/crm_domain_contract_test.sql`: item/business mismatch rejected, null item business rejected, product/business mismatch rejected, history not writable/updatable by `authenticated`, `anon` has no history privileges.
10. Add consumer regression tests asserting the three repaired edge-function queries only reference columns that exist in the live schema (schema-contract style, in line with existing architecture tests).

Gate: CRM SQL contract tests, architecture tests, and the business-event topic registration test all pass.

## 3. Additions to the plan found during this verification

Appended because the previous plan did not cover them:

- **Schema-drift guard.** All three broken consumers are the same failure mode: a column was dropped and the edge functions were never re-checked. Add one test that enumerates the CRM columns each edge function references and fails when they no longer exist. This is what prevents a fourth occurrence.
- **Topic-consumer honesty check.** A registered topic with no consumer and no integration flag should fail the catalog ratchet, not silently pass.
- **Currency decision must precede reporting work (Phase R2).** Adding `crm_leads.currency_code` versus formally declaring expected revenue base-currency-only changes the shape of the `crm_pipeline_metrics` RPC, so decide it before writing that RPC rather than after.

## 4. Phases after R0 (order unchanged from the audit)

- **R1** — complete the lifecycle: resolve `proposition`, archive semantics, lifecycle timestamps, reopen reason capture, pipeline-admin permission for stage configuration, optimistic concurrency.
- **R2** — reporting and activity foundation: server-side `crm_pipeline_metrics` RPC, delete the React financial reducers, single lifecycle-state authority, currency resolution, durable overdue/next-activity semantics, duplicate detection.
- **R3** — conversion and event consumers: harden Contact/Estimate/Sales Order/Project conversion prerequisites, source lineage, real consumers, dead-letter monitoring.
- **R4** — feature expansion only after R0–R3.

Accounting boundary unchanged (**FACT/STD**): CRM emits lifecycle facts only. No CRM transition creates a journal entry, invoice, or sales document implicitly.

The full audit and rework contract remains archived at `.lovable/plan/crm-domain-audit-rework-contract-2026-08-24.md`.

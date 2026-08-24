# CRM Domain Audit — Phase 3 completion plan (verified handover)

Labels: **FACT** = verified now against this repo/database · **STD** = established ERP/CRM practice · **INFER** = reasoned conclusion.

## 1. Verification of the previous engineer's handover

Re-derived from the live catalog, not from the log.

| Claim | Verdict | Evidence |
|---|---|---|
| Phase 2 complete — server-owned lifecycle | **CONFIRMED** | `crm_lead_status` enum (`new, qualified, proposition, won, lost`); write guard `_crm_lead_lifecycle_write_guard`; scope guard `_crm_lead_scope_guard`; transition table `_crm_assert_transition`; eight RPCs present (`crm_qualify_lead`, `crm_change_stage`, `crm_mark_won`, `crm_mark_lost`, `crm_reopen_lead`, `crm_reassign_lead`, `crm_revalue_lead`, `crm_archive_lead`), each gated by `_crm_assert_lead_access` and each logging a system activity |
| Phase 3 step 1 — `crm_lead_history` table landed | **CONFIRMED** | table exists with from/to status, stage, value, assignee, actor, reason, metadata; immutability trigger `_crm_lead_history_immutable` present |
| Phase 3 — history is actually written | **FALSE** | no `_crm_lead_history_record` function and no trigger/RPC writes a single history row. The table is empty scaffolding |
| Phase 3 — outbox events | **FALSE** | no `crm%` row in `business_event_topics`, no CRM emitter, no `crm.lead.*` handler in `supabase/functions/outbox-dispatcher/index.ts` |

Two additional **FACT**s found during verification, not in the previous log:

- `crm_revalue_lead` updates `expected_revenue` **without** setting `app.crm_lead_writer`, unlike every sibling RPC. It works only because the guard exempts non-terminal leads — a latent break the moment the guard tightens.
- `emit_business_event` whitelists only `product.import.*` and `stock.*`, so CRM cannot reuse it. CRM needs its own emitter, and the dispatcher's `HANDLERS` map is a **closed registry** — an unregistered topic dead-letters as `unknown_event_type`. Emitting without adding dispatcher entries would break `supabase/tests/business_event_topic_registration_test.sql`.

Resume at **Phase 3, step 2**.

## 2. Phase 3 — history + business events (this milestone)

**Architectural correction to the previous plan.** The previous plan patched all eight RPCs to record history individually. Instead, history is recorded by **one AFTER UPDATE trigger on `crm_leads`** that derives the event from the old/new row. Rationale (INFER): the write guard already makes the RPCs the only possible writers, so a trigger captures every transition by construction and no future RPC can forget to log. Reasons are passed to the trigger through a session setting (`app.crm_lead_reason`) set by the three reason-bearing RPCs, mirroring the existing `app.crm_lead_writer` idiom.

Migrations, one object each (per the project's small-migration rule):

1. `_crm_lead_history_record()` + `AFTER UPDATE` trigger on `crm_leads`. Derives one primary event (`archived` > `won` > `lost` > `reopened` > `qualified` > `stage_changed`) plus independent `reassigned` / `revalued` rows, and records from/to status, stage, value, assignee, actor, reason, metadata.
2. `_crm_emit_lead_event()` + `AFTER INSERT` trigger on `crm_lead_history`, inserting into `business_event_outbox` with `source = 'crm'`, `event_type = 'crm.lead.<event>'`, `source_doc_type = 'crm_lead'`, idempotency key `crm.lead:<lead_id>:<event>:<epoch of occurred_at>`.
3. Patch `crm_mark_lost`, `crm_reopen_lead`, `crm_archive_lead` to publish their reason via `set_config('app.crm_lead_reason', …, true)`, and patch `crm_revalue_lead` to set `app.crm_lead_writer` like every sibling.
4. Register the eight topics in `business_event_topics` (`producer_domain = 'crm'`, `handler_scope = 'server'`): `crm.lead.qualified`, `.stage_changed`, `.won`, `.lost`, `.reopened`, `.reassigned`, `.revalued`, `.archived`.

Code:

- Add the eight topics to the dispatcher `HANDLERS` map in `supabase/functions/outbox-dispatcher/index.ts` as record-only handlers (state is already durable in `crm_leads`), and redeploy the function. Without this the events dead-letter.
- Refresh generated Supabase types so `crm_lead_history` is typed.
- Surface the lifecycle timeline in `LeadDetailsDialog` (read-only list from `crm_lead_history`, newest first: event, actor, from → to, reason, timestamp).

Tests:

- Extend `supabase/tests/crm_lifecycle_state_machine_test.sql`: each transition writes exactly one history row of the right event with correct from/to values, and one matching outbox row; history rows reject UPDATE/DELETE.
- Catalog ratchet: every `crm.lead.*` topic emitted by the database is registered in `business_event_topics` (already enforced generically) **and** present in the dispatcher map.

**Accounting boundary unchanged (STD/FACT):** CRM emits lifecycle facts only. No journal, no invoice, no sales document is created by any CRM transition.

## 3. Phases after this one (unchanged order)

4. Branch dimension + remaining cross-business integrity.
5. Server-side `crm_pipeline_metrics` RPC; delete the React reducers; add `currency_code`.
6. Sales/Project edge correction; stage-deletion impact guard.
7. Activity loop: maintained `next_activity_date`, auto system activities, server-side overdue.

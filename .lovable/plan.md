# CRM Domain Audit — Authoritative Status (updated 2026-08-24, late)

Labels: **FACT** = verified against this repo/database now · **STD** = established ERP/CRM practice · **INFER** = reasoned conclusion.

Prior documents (do not treat as current status):
`.lovable/plan/crm-domain-audit-rework-contract-2026-08-24.md` (audit + defect register D1–D12),
`.lovable/plan/crm-domain-audit-phase-3-completion-plan-verified-handover-2026-08-24.md` (Phase 3 contract).

---

## Currently active phase

**Phase 3 — COMPLETE and verified.** Next active phase is **Phase 4 (branch dimension + cross-business referential integrity)**. Nothing in Phase 4 has been started.

---

## Fully implemented and verified

### Phase 1 — conversion bridge and tenancy repair (D1, D2, D3, D5, D6)
- Conversion RPCs supply `crm_activities.business_id`; conversions no longer abort.
- All CRM SECURITY DEFINER functions authorize the caller.
- Lead numbering is atomic/monotonic (no `COUNT(*)+1`).
- CRM RLS is business-scoped; `anon` holds no privileges on `crm_*`.
- Guards: `supabase/tests/crm_domain_contract_test.sql`, `crm_conversion_idempotency_test.sql`.

### Phase 2 — server-owned lifecycle state machine (D8, D9)
- `crm_lead_status` enum (`new, qualified, proposition, won, lost, archived`) is the single source of truth; `stage_id` is presentation ordering only.
- Eight transition RPCs: `crm_qualify_lead`, `crm_change_stage`, `crm_mark_won`, `crm_mark_lost`, `crm_reopen_lead`, `crm_reassign_lead`, `crm_revalue_lead`, `crm_archive_lead` — all gated on `_crm_assert_lead_access`.
- `_crm_lead_lifecycle_write_guard` rejects any direct client UPDATE of lifecycle columns; `_crm_lead_scope_guard` enforces same-business stage/contact/assignee.
- Terminal consistency, one won/one lost stage per business, stage-deactivation guard.
- Guard: `supabase/tests/crm_lifecycle_state_machine_test.sql`.

### Phase 3 — authoritative history + business events (this milestone) — **VERIFIED**
**FACT, each item re-checked against the live catalog:**
- `_crm_lead_history_record()` + `AFTER UPDATE` trigger `crm_leads_history_record` derives one primary event (`archived > won > lost > reopened > qualified > stage_changed`) plus independent `reassigned` / `revalued` rows, recording from/to status, stage, value, assignee, actor, reason, metadata. Because the write guard makes the RPCs the only possible writers, no future RPC can forget to log.
- `_crm_emit_lead_event()` + `AFTER INSERT` trigger `crm_lead_history_emit_event` publishes to `business_event_outbox` with `source='crm'`, `event_type='crm.lead.<event>'`, `source_doc_type='crm_lead'`, idempotency key `crm.lead:<lead_id>:<event>:<epoch>`.
- `crm_mark_lost` / `crm_reopen_lead` / `crm_archive_lead` publish their reason via `set_config('app.crm_lead_reason', …, true)`; `crm_revalue_lead` now sets `app.crm_lead_writer` like its siblings.
- `crm_lead_history` is append-only (UPDATE and DELETE both refused).
- Eight topics registered in `business_event_topics` (`producer_domain='crm'`, `handler_scope='server'`).
- Dispatcher: eight record-only handlers added to `supabase/functions/outbox-dispatcher/index.ts`; **function redeployed**. CRM events no longer dead-letter as `unknown_event_type`.
- UI: read-only **History** tab on `LeadDetailsDialog` (`src/components/crm/LeadHistoryTimeline.tsx`, `src/hooks/crm/useLeadHistory.ts`) — newest first, event, from → to, reason, timestamp.
- Tests: `supabase/tests/crm_lead_history_and_events_test.sql` (triggers attached, topics registered, one correct history row + one matching outbox row per transition, reasons persisted, append-only) and `src/test/architecture/crm-lead-topics-dispatched.test.ts` (**passing**).
- Verification run: behavioural block executed against the live database inside a rolled-back transaction — all assertions passed. `tsgo --noEmit` clean.

**Accounting boundary unchanged (FACT):** CRM emits lifecycle facts only. No CRM transition writes a journal, invoice or sales document.

---

## Still pending (in roadmap order)

### Phase 4 — branch dimension + remaining cross-business integrity (D4, D7) — NEXT
- Add `branch_id` to `crm_leads`, `crm_stages`, `crm_activities`, `crm_lost_reasons` (nullable at first, backfilled from the lead's business default, then constrained).
- Branch must be scoped in RLS and in `_crm_assert_lead_access`; pipeline and reporting must be branch-filterable.
- Composite `(business_id, id)` foreign keys (or validation triggers) for `stage_id`, `contact_id`, `lost_reason_id`; constrain `assigned_to` to a member of that business.
- Ratchets extending `crm_domain_contract_test.sql`.

### Phase 5 — pipeline metrics as a server contract (D11)
- `crm_pipeline_metrics` RPC (open opportunities only, business + branch scoped, no row cap); delete the React reducers in `CRMDashboard.tsx` / `CRMPipeline.tsx`; retire or fold in `calculate_pipeline_value`.
- Add `currency_code` to `crm_leads` and resolve through the canonical FX resolver — never `COALESCE(rate, 1)`.

### Phase 6 — Sales/Project edge correction; stage-deletion impact guard (D10)
- Server-side stage archive with live-lead impact analysis and mandatory reassignment; sequence uniqueness; stage audit.

### Phase 7 — activity loop (D12)
- Trigger-maintained `crm_leads.next_activity_date/summary`, server-side overdue derivation, auto system activities on lifecycle events, reminder consumer.

---

## Instructions for the next agent

1. **Verify Phase 3 before writing anything.** Do not trust this document. Confirm in the live catalog: triggers `crm_leads_history_record` and `crm_lead_history_emit_event` exist; the eight `crm.lead.*` rows exist in `business_event_topics`; `supabase/functions/outbox-dispatcher/index.ts` contains all eight handler entries and is deployed; `business_event_outbox_dead` holds no `crm.lead.*` rows. Run `src/test/architecture/crm-lead-topics-dispatched.test.ts` and the behavioural block of `supabase/tests/crm_lead_history_and_events_test.sql` (the RPCs need `auth.uid()`, so the harness drives transitions through the guarded write path — keep it that way).
2. **Then resume at Phase 4**, in the order listed. Do not jump to Phase 5–7 work or unrelated domains.
3. **Migration discipline:** one object per migration, no batching (project core rule).
4. Bring Phase 4 to a coherent, production-ready state — schema, RLS, guards, UI filter, ratchet tests — before opening Phase 5.
5. Update this file immediately after each implementation step.



============================KINDLY NOTE
Phase 4 is partially landed. Here's exactly where things stand.

Applied and live (verified by the migration runs):

branch_id added to crm_leads (backfilled to each business's HQ/default branch, indexed, business/branch consistency trigger), crm_activities (auto-inherited from the lead via _crm_activity_branch_from_lead), crm_stages and crm_lost_reasons (NULL = shared business-wide).
_crm_lead_scope_guard now rejects branch-specific stages/lost reasons that don't match the lead's branch.
Branch-scoped RLS on crm_leads, crm_activities, crm_stages, crm_lost_reasons, following the existing invoices pattern (branch_id IS NULL OR user_can_access_branch(...) OR finance.view_consolidated).
_crm_assert_lead_access enforces branch access, so the SECURITY DEFINER transition RPCs can't bypass branch isolation.
crm_lead_history gained branch_id/from_branch_id/to_branch_id; the recorder logs a branch_transferred event.
_crm_lead_lifecycle_write_guard now protects branch_id, and a governed crm_transfer_lead_branch(lead, branch, reason) RPC exists (validates business, active branch, both-branch access, refuses won/lost leads, remaps a branch-specific stage, re-aligns activities).
Failed — must be redone: the last migration errored with: ERROR: 42703: column "event_type" of relation "business_event_topics" does not exist So the event payload was not updated with branch fields and the crm.lead.branch_transferred topic is not registered. Until that is fixed, a branch transfer will emit an event that the outbox dispatcher treats as an unknown type and dead-letters.

Remaining Phase 4 work for the next agent (in order):

Inspect the real column names of business_event_topics (\d), then re-apply the _crm_emit_lead_event update (branch fields in the payload) plus the crm.lead.branch_transferred topic row.
Add a crm.lead.branch_transferred record-only handler to supabase/functions/outbox-dispatcher/index.ts and redeploy; confirm no crm.lead.* rows in business_event_outbox_dead.
UI: branch selector on lead create, branch column/filter in pipeline and lead list, "Transfer branch" action wired to crm_transfer_lead_branch, and branch shown in the History timeline.
Ratchet tests: extend supabase/tests/crm_domain_contract_test.sql with branch isolation (cross-branch stage/lost-reason rejection, direct branch_id UPDATE rejection, RLS visibility) and add the dispatcher topic assertion for the new event.
Update .lovable/plan.md to reflect the above — I did not get to updating it, so it still shows Phase 4 as unstarted, which is now inaccurate.
I stopped before touching .lovable/plan.md, the dispatcher, the UI, and the tests, so nothing is half-written in the codebase; the divergence is only that the database is ahead of the plan document.
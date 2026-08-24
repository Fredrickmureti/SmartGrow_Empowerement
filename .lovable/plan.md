# CRM Domain — Authoritative Status (2026-08-25) and Next Milestone

Labels: **FACT** = verified against the live repo/database in this session · **STD** = established ERP/CRM practice · **INFER** = reasoned conclusion.

This file is the single source of truth for CRM domain status. It is updated immediately after each implementation step.

## 1. Currently active phase

**Phase 4 — Branch dimension + cross-business referential integrity: COMPLETE and verified.**
Next phase to open: **Phase 5 — pipeline metrics as a server contract (D11).**

## 2. Fully implemented and verified

### Phases 1–3 (earlier sessions, re-verified from the live catalog)
- Tenancy repair: every CRM table business-scoped; RLS policies reference `business_id`; `anon` holds no CRM privileges.
- Server-owned lifecycle: guarded transition RPCs, `crm_leads_terminal_consistency` check, lifecycle write guard blocking direct client mutation of governed columns.
- Authoritative history + events: append-only `crm_lead_history` with trigger recording, eight `crm.lead.*` topics registered with matching outbox-dispatcher handlers.

### Phase 4 (this session and the one before it)
| Item | Status | Evidence (FACT) |
|---|---|---|
| `branch_id` on `crm_leads`, `crm_stages`, `crm_activities`, `crm_lost_reasons`; `branch_id`/`from_branch_id`/`to_branch_id` on `crm_lead_history` | DONE | Catalog check passes |
| Governed transfer RPC `crm_transfer_lead_branch` (SECURITY DEFINER) + branch checks in `_crm_assert_lead_access` | DONE | Catalog check passes |
| Event payload carries `branch_id`, `from_branch_id`, `to_branch_id` | DONE | `_crm_emit_lead_event` definition asserted by ratchet |
| `crm.lead.branch_transferred` registered in `business_event_topics` (`topic_prefix`) | DONE | Ratchet asserts the row |
| Outbox dispatcher handles `crm.lead.branch_transferred` (ninth handler), redeployed | DONE | `supabase/functions/outbox-dispatcher/index.ts` |
| UI: branch on lead create, branch filter on pipeline, governed "Transfer branch" action, branch in History timeline | DONE | `useLeads.ts`, `LeadForm.tsx`, `CRMPipeline.tsx`, `LeadDetailsDialog.tsx`, `LeadHistoryTimeline.tsx` |
| **D7 — cross-business referential integrity** | DONE | See below |
| **Phase 4 ratchet tests** | DONE | See below |

**D7 (closed this session).** Three migrations, one concern each:
1. `UNIQUE (business_id, id)` identity keys added to `crm_stages`, `crm_lost_reasons`, `contacts`, `branches`.
2. Single-column FKs on `crm_leads` replaced with composite, business-carrying FKs:
   `crm_leads_business_stage_fkey`, `crm_leads_business_contact_fkey`,
   `crm_leads_business_company_contact_fkey`, `crm_leads_business_lost_reason_fkey`,
   `crm_leads_business_branch_fkey`. Business A can no longer reference Business B's rows on **any** write path, guarded or not.
3. `crm_leads_assignee_guard` trigger (`_crm_lead_assignee_guard`, SECURITY DEFINER, `search_path=public`, EXECUTE revoked from PUBLIC/anon/authenticated): `assigned_to` must be an active `user_roles` member of the lead's organization.

Pre-migration data audit found zero violating rows across all five references and all assignees, so the constraints were added against clean data.

**PostgREST fallout handled.** Renaming the FKs changed the embedded-resource hints. `src/hooks/crm/useLeads.ts` and `src/pages/crm/CRMActivities.tsx` now use the new constraint names
(`contacts!crm_leads_business_company_contact_fkey`, `branches!crm_leads_business_branch_fkey`). This also cleared the `TS2589` deep-instantiation error in `CRMActivities.tsx`. `bunx tsgo --noEmit` is clean across the whole project.

**Ratchet tests.** `supabase/tests/crm_domain_contract_test.sql` extended with catalog-level blocks:
D7a composite FK presence, D7b `(business_id, id)` identity keys, D7c assignee guard trigger + function shape, branch column presence across CRM tables, history from/to branch trail, governed-transfer RPC + branch clause in the lifecycle write guard, branch fields in the emitted event payload, and topic registration. All blocks executed against the live database: **phase4 ratchets pass**.

## 3. Still pending (roadmap order — do not reorder)

- **Phase 5 — pipeline metrics as a server contract (D11).** `crm_pipeline_metrics` RPC: open opportunities only, business **and branch** scoped in the signature (branch is a first-class parameter, not a post-filter), no row cap. Delete the React reducers in `CRMDashboard.tsx` / `CRMPipeline.tsx`. Retire or fold in `calculate_pipeline_value`. Add `currency_code` to `crm_leads` and resolve through the canonical FX resolver — never `COALESCE(rate, 1)`. Ships with its own ratchet test.
- **Phase 6 — stage-deletion impact guard + Sales/Project edge correction (D10).** Server-side stage archive with live-lead impact analysis and mandatory reassignment; stage sequence uniqueness per business; stage change audit; must also handle branch-scoped stages.
- **Phase 7 — activity loop (D12).** Trigger-maintained `crm_leads.next_activity_date` / `next_activity_summary`, server-side overdue derivation, automatic system activities on lifecycle events, reminder consumer.

## 4. Known non-blockers

- The Supabase linter reports ~3.6k pre-existing project-wide findings (SECURITY DEFINER execute grants, security definer views, mutable search paths, leaked-password protection). None were introduced by the Phase 4 migrations; the count is unchanged before and after. They belong to a separate platform-wide security wave, not to the CRM roadmap.
- Runtime browser verification of the CRM pages could not be performed end-to-end: this project uses an external/unmanaged Supabase auth surface, so no preview session can be minted. Verification was done at the catalog and typecheck level instead.

## 5. Instructions for the next agent

1. **Verify before you build.** Do not trust this document. Re-derive Phase 4 from the live catalog:
   - run the Phase 4 blocks of `supabase/tests/crm_domain_contract_test.sql` against the database and confirm they pass;
   - confirm the five composite FKs and the assignee guard trigger exist on `crm_leads`;
   - confirm `crm.lead.branch_transferred` is registered and the dispatcher has a handler for it, and that no `crm.lead.*` rows have landed in `business_event_outbox_dead`;
   - confirm the CRM UI still queries with the renamed FK hints and that `bunx tsgo --noEmit` is clean.
   If anything fails, repair Phase 4 first — do not open Phase 5 on a broken foundation.
2. **Then resume at Phase 5** (pipeline metrics as a server contract). Do not pick unrelated work, do not skip ahead to Phase 6/7.
3. **Working rules.** One object/concern per migration; no batching. Every phase lands schema + guards + event contract + UI + ratchet test before the next opens. Update this file immediately after each implementation step.

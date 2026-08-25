# CRM Domain — Phase R1 complete · Phase R2 next

Labels: **FACT** = verified now against this repo/database · **STD** = established ERP/CRM practice · **INFER** = reasoned conclusion.

## 1. Phase R1 — COMPLETE (2026-08-25)

**Database / server (applied earlier, verified against the live DB)**

- `crm_leads` carries `qualified_at`, `proposition_at`, `reopened_at`, `reopen_count`, `reopen_reason`, `archived_at`, `archived_by`, `archive_reason`, `version`, backfilled from `crm_lead_history`. **FACT**
- Server-owned version-bump trigger plus `_crm_assert_version`; every lifecycle RPC takes `p_expected_version` and raises `40001` on conflict. **FACT**
- New RPCs `crm_mark_proposition`, `crm_withdraw_proposition`, `crm_restore_lead`; archive records who/when/why and refuses leads with downstream documents. **FACT**
- Write guard extended to the new columns and to archived leads; history trigger emits `proposition`, `proposition_withdrawn`, `restored`; those topics are registered `integration_only` and wired in `outbox-dispatcher`. **FACT**
- Pipeline stage writes gated on `crm_can_admin_pipeline` (settings.write) rather than `sales.write`. **FACT**
- Ratchets in `crm_domain_contract_test.sql` and `crm_lifecycle_state_machine_test.sql`; R1 invariant checks executed against the live DB and passed. **FACT**

**Frontend (finished in this pass)**

- `Lead` type gained the server-owned `status` field (`crm_lead_status`: new / qualified / proposition / won / lost), which the dialog's lifecycle branching depends on. **FACT**
- `useLeads` exposes `markAsProposition`, `withdrawProposition`, `restoreLead`, version-aware calls and an `archivedOnly` mode. **FACT**
- `LeadDetailsDialog`: footer now renders "Mark as Proposition" / "Withdraw Proposition" driven by `isProposition`; the legacy delete `AlertDialog` (and its dangling `confirmDelete` reference and `showDeleteDialog` state) is gone, replaced by two `ReasonDialog`s bound to `confirmWithdrawProposition` and `confirmArchive`; `onDelete` widened to `(leadId, reason?, version?)`. **FACT**
- `CRMPipeline`: an "Archived" button mounts `ArchivedLeadsDialog` (restores refresh the board); `onDelete={deleteLead}` unchanged; the stage-settings gate moved off `manageSales` onto the settings-write permissions (`manageBusiness` / `manageOrganization` / `manageTaxSettings`) so the UI mirrors `crm_can_admin_pipeline`. Note `editSettings` was rejected for this gate because in `src/lib/permissions.ts` it maps to `settings.read`, which would be looser than the server policy. **FACT**

**Verification**: `tsgo --noEmit` clean; `crm-lifecycle-rpc-only`, `crm-no-client-conversion`, `useLeads.convertToProject` — 6 tests passing. **FACT**

## 2. Phase R2 — COMPLETE (2026-08-25)

1. **Event consumer posture resolved.** All twelve `crm.lead.*` topics carry `integration_only = true` in `business_event_topics` with an empty `consumer_domains`, and `crm_domain_contract_test.sql` (R0 check) already fails any CRM topic that has neither a consumer nor that flag — so the registry no longer implies a missing in-app consumer. The dispatcher ratchet `crm-lead-topics-dispatched.test.ts` was widened from 8 to all 12 topics (`restored`, `branch_transferred`, `proposition`, `proposition_withdrawn` added) so a new topic without a handler can't dead-letter unnoticed. **FACT**
2. **Lead-level currency.** `crm_leads.currency` added (NOT NULL), backfilled from `businesses.base_currency`; trigger `crm_leads_currency_default` defaults it server-side and validates it through `_assert_currency_is_active`, and the trigger helper's EXECUTE is revoked from anon/authenticated. `Lead.currency` is exposed by `useLeads`, and lead cards, the details sheet and the archived list format amounts in the lead's own currency. Pipeline / weighted / won totals now sum base-currency opportunities only and disclose the excluded count, because this surface performs no FX conversion. **FACT**
3. **Reopen flow in the UI.** `LeadDetailsDialog` renders a "Reopen" action for won/lost opportunities, backed by a mandatory-reason `ReasonDialog` calling `crm_reopen_lead` with the row version. **FACT**
4. **Archive/restore reach.** `ArchivedLeadsDialog` is now mounted on the CRM dashboard (Quick Actions → "Archived") in addition to the pipeline board. The contact profile keeps its read-only lead list — archived leads are out of scope there. **FACT**

**Verification**: `tsgo --noEmit` clean; 27 CRM architecture tests passing (`crm-business-scoped`, `crm-lead-topics-dispatched`, `crm-edge-consumer-schema`, `crm-lifecycle-rpc-only`, `crm-no-client-conversion`). **FACT**

## 3. Candidates for a future phase

- FX-aware pipeline aggregation (convert non-base-currency opportunities via the existing FX engine rather than excluding them).
- Editing an opportunity's currency post-creation through a governed RPC alongside `crm_revalue_lead`.
- Real in-app consumers for the CRM lifecycle events if a sales-handoff or notification requirement appears.

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

## 2. Phase R2 — next

Scope to confirm at kickoff, carried forward from the domain audit:

1. **Event consumers, not just instrumentation.** Every `crm%` topic still has an empty `consumer_domains` list; R2 should give the lifecycle events at least one real consumer (e.g. sales handoff on `won`, activity/notification fan-out) or explicitly mark them integration-only in the contract test.
2. **Lead-level currency.** `crm_leads` has no `currency_code`, so expected revenue has no declared currency; add it with a business-default backfill and surface it in the pipeline totals instead of assuming base currency.
3. **Reopen flow in the UI.** The server supports `reopened_at` / `reopen_count` / `reopen_reason`, but no client surface performs a reopen after won/lost.
4. **Archive/restore reach.** `ArchivedLeadsDialog` is currently only mounted on the pipeline board; decide whether the CRM dashboard and contact profile need the same entry point.

First action for the next agent: confirm items 1-4 against the live catalog before writing any migration, per the standing "verify before asserting" rule.

# CRM Phase R1 — Finish the UI wiring, then update plan status

Labels: **FACT** = verified now against this repo · **INFER** = reasoned conclusion.

## 1. Current state (verified now)

- `LeadDetailsDialog.tsx` (647 lines) already has `isProposition`, `handleMarkAsProposition`, `confirmWithdrawProposition`, `confirmArchive`, and the states `showWithdrawDialog` / `showArchiveDialog`. **FACT**
- It still declares `showDeleteDialog` (line 129) and renders the old delete `AlertDialog` (lines 618-644) whose confirm handler calls `confirmDelete` — **a function that no longer exists in the file**. This is a hard build/type break, not just dead UI. **FACT**
- Neither `ReasonDialog` for withdraw nor for archive is mounted, so `showWithdrawDialog` / `showArchiveDialog` currently open nothing and `handleDelete` is a dead end. **FACT**
- `onDelete?: (leadId: string) => Promise<void>` (line 69) is narrower than the call `deleteLead(lead.id, reason, lead.version)` (line 281). **FACT**
- No proposition buttons exist in the `footer` block (lines 324-425). **FACT**
- `CRMPipeline.tsx` does not import or mount `ArchivedLeadsDialog`; it passes `onDelete={deleteLead}` (line 322) already, and gates stage settings with `PermissionGate permission="manageSales"` (lines 214, 273). **FACT**
- `ArchivedLeadsDialog` and `ReasonDialog` exist with the props the wiring needs (`open`, `onOpenChange`, `onRestored`; `title`, `description`, `confirmLabel`, `onConfirm`, `destructive`). **FACT**

Note on the permission switch: in `src/lib/permissions.ts`, `settings.write` maps to `manageBusiness` / `manageOrganization` / `manageTaxSettings`, while `editSettings` is `settings.read`. Gating the stage-settings button on `editSettings` alone would be looser than the new server policy `crm_can_admin_pipeline` (settings.write). **FACT/INFER** — the plan gates on the settings *write* permissions instead, so the UI matches the server.

Two live build errors, both from this half-finished wiring: **FACT**

- `LeadDetailsDialog.tsx(245,30)` — `Property 'status' does not exist on type 'Lead'`. `crm_leads.status` (enum `crm_lead_status`) exists in the database and the query selects `*`, but the `Lead` interface in `src/hooks/crm/useLeads.ts` never gained the field.
- `LeadDetailsDialog.tsx(631,24)` — `Cannot find name 'confirmDelete'`, inside the old delete `AlertDialog` that step 3 removes.


## 2. Work to complete R1

**LeadDetailsDialog**
1. Widen `onDelete?: (leadId: string, reason?: string, version?: number | null) => Promise<void>`.
2. Add footer buttons between the Won/Lost group and "Convert To": "Mark as Proposition" when `!isWonOrLost && !isProposition`, "Withdraw Proposition" (opens `showWithdrawDialog`) when `isProposition`.
3. Delete the `showDeleteDialog` state and the whole old `AlertDialog` block (618-644), which also removes the dangling `confirmDelete` reference.
4. Mount two `ReasonDialog`s: withdraw (`onConfirm={confirmWithdrawProposition}`) and archive (`destructive`, `onConfirm={confirmArchive}`), bound to their existing states.
5. Drop now-unused imports (`AlertDialog*` family) if nothing else uses them.

**CRMPipeline**
6. Add an "Archived" button (Archive icon) next to the export/settings controls that opens a mounted `ArchivedLeadsDialog`, with `onRestored` refreshing the board.
7. Keep `onDelete={deleteLead}` unchanged.
8. Change the stage-settings gate from `manageSales` to the settings-write permissions (`manageBusiness`, `manageOrganization`, `manageTaxSettings`, any-of) so it mirrors `crm_can_admin_pipeline`; the "New Lead" button stays on `manageSales`.

**Verify and record**
9. Run typecheck and the CRM test suites (`crm-lifecycle-rpc-only`, `crm-no-client-conversion`, `useLeads.convertToProject`, plus the SQL ratchets already added).
10. Rewrite `.lovable/plan.md`: R1 marked complete with the verified evidence, and R2 stated as the next phase.

## 3. Technical detail

No database or RPC changes — R1's server side is already applied. All edits are presentation/wiring in two files plus the plan document. Version values flow from `lead.version` into the existing hook calls, so optimistic-concurrency behaviour (40001 → conflict toast) is unchanged.

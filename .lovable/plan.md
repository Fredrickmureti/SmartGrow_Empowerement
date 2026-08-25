# CRM: make every lead discoverable and give it a real lifecycle

## What I verified in this project (not assumed)

- The database has **1 lead, 0 CRM stages** for the single business, and that lead has **no stage**. So the symptom is real.
- The previous agent's trigger **is already installed** (`crm_leads_default_stage` on `crm_leads`, BEFORE INSERT) and its backfill already ran — yet the lead is still stage-less. That proves the trigger cannot fix the case that actually happened: with zero stages there is nothing to assign, so it silently leaves `stage_id` NULL. The trigger is a useful safety net, not the fix.
- `crm_stages.business_id` is NOT NULL and `branch_id` is nullable; the trigger scopes by organization + business (+ branch) and orders by `sequence`, then `created_at`. Tenant isolation and determinism are acceptable. The `business_id IS NULL` branch is dead code but harmless.
- Stage moves are **server-owned**: direct writes to `stage_id`, `status`, `probability`, `assigned_to`, `is_active` are rejected by `_crm_lead_lifecycle_write_guard`; moves must go through `crm_change_stage` / `crm_mark_won` / `crm_mark_proposition` etc. The hook `useLeads` already wraps these correctly with optimistic-concurrency versions.
- Stage deactivation is guarded server-side (`_crm_stage_deactivation_guard`), so a stage holding open leads cannot be archived — leads cannot be orphaned that way.
- `src/pages/crm/CRMLeads.tsx` exists but is **not routed and not in the nav**, so it is currently dead code.
- `LeadDetailsDialog` only **displays** the stage — there is no way to assign or change a stage from anywhere except drag-and-drop on the kanban board. A stage-less lead therefore cannot be placed on the board at all, even once stages exist.
- Pipeline's "No pipeline stages configured" empty state only links to the stage settings dialog; it never mentions that leads already exist and are hidden.
- `seedDefaultStages()` exists in `useCRMStages` but nothing calls it.

## Root-cause conclusion (corrected)

The previous agent found a symptom, not the root cause. The real defects are:

1. **A fresh CRM install is allowed to have zero pipeline stages**, which makes the primary work surface unusable and creates leads with no stage. Provisioning is missing, not repair.
2. **Leads have no record-management surface.** The kanban board is a work-management *visualization*; it was being used as the only access path to lead records. Any lead the board's rendering rule excludes (no stage) becomes invisible while still counting in statistics.
3. **Stage assignment has no non-drag UI**, so the "assign a stage" step of the lifecycle is unreachable for exactly the leads that need it.

## Decisions

- **Keep** the `crm_leads_default_stage` trigger. It is the right owner of "an opportunity created through any path (UI, import, RPC) lands in the first open stage", it is tenant-scoped, deterministic, and idempotent. No new migration is needed; it is already applied.
- **Do not** make `stage_id` mandatory. A stage-less lead is a legitimate intermediate state (pre-configuration, imports, custom funnels). Instead, the state must be *visible and resolvable*, never silent.
- **Provision stages, don't repair leads.** Offer the standard funnel from the Pipeline empty state via `seedDefaultStages()`, and let the trigger handle every lead created afterwards.
- **Leads list becomes a first-class surface**, the canonical place to find, search, filter, inspect and edit a lead. Pipeline stays the board.

## Work to do

### 1. Wire up the Leads surface
- Register `/crm-app/leads` in `src/apps/crm/routes.tsx` (lazy, same `OnlineOnlyRoute` + `SubscriptionProtectedRoute` wrapper as Pipeline).
- Add "Leads" to `CRM_NAV` in `src/apps/crm/nav.ts`, placed above Pipeline.

### 2. Close the lifecycle gap: stage assignment from the record
- Add a stage control to `LeadDetailsDialog` that calls `moveToStage` (`crm_change_stage`) with the lead's `version`, permission-gated on `manageSales`, hidden for won/lost leads, and excluding won/lost stages (those keep their dedicated actions).
- When no stages exist, the control explains that and links to Pipeline instead of showing an empty dropdown.

### 3. Distinct, honest empty states
- **Pipeline, zero stages:** keep the existing card but add a primary "Create default stages" action calling `seedDefaultStages()`, and — when leads already exist — state how many leads are waiting and link to Leads.
- **Leads page:** separate messages for (a) no leads at all, (b) leads exist but no stages configured, (c) filters match nothing, (d) only archived leads exist. The existing single generic "No leads match these filters" is replaced.
- Keep the stage-less warning banner, but make its call to action open the lead rather than describe database state.

### 4. Statistics agree with records
- Pipeline's "Open Leads" card links to the Leads list filtered to open leads, so any number a user sees is clickable through to inspectable records.

### 5. Verification
- `npx tsgo --noEmit`.
- Run the CRM-related tests in `src/test`.
- Manual pass in the preview: fresh state (0 stages, 1 stage-less lead) → find lead in Leads → open → edit → seed default stages from Pipeline → assign stage from the detail dialog → confirm it appears on the board and the counters agree; then create a new lead and confirm the trigger places it automatically.

## Explicitly out of scope
- No new migration; the schema and triggers already support the design.
- No change to the lifecycle RPCs, permissions, or RLS.
- No lead/opportunity split or conversion redesign.

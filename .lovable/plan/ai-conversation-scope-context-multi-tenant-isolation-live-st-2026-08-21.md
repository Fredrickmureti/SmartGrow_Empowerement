# AI Conversation Scope, Context & Multi-Tenant Isolation — Live Status

Architectural contract: `.lovable/plan/ai-conversation-scope-context-multi-tenant-isolation-audit-r-2026-08-21.md`
(sections 3, 4, 6 remain binding). This file is the authoritative status record.

## Handover verification (this pass, independent)

Every Phase 1–4 claim was re-checked against the live database and source. Result: **claims hold**.

| Claim | Verified by | Verdict |
| --- | --- | --- |
| Scope columns on conversations/messages | `information_schema.columns`: `ai_conversations` has organization_id, business_id, branch_id, app_key, module_key, record_type, record_id, scope_level, created_by, archived_at, last_message_at; messages denormalise `organization_id` | TRUE |
| RLS + helpers | `pg_policies`: conversations `created_by = auth.uid() AND can_access_ai_conversation_scope(...)`; messages via `can_read_ai_conversation(...)` on all of SELECT/INSERT/DELETE | TRUE |
| Server-owned history | `ai-assistant/index.ts`: JWT auth gate, org membership check against `user_roles`, `can_read_ai_conversation` RPC gate, history read from DB (40 turns), only newest client user turn trusted | TRUE |
| Client trust reduction | `userRole` / `accessibleBranchIds` ignored from body and re-derived from `user_roles` + `user_branch_assignments` | TRUE |
| Scope-bound threads | `useAIConversation.ts` rebinds on org/business/branch/app/scopeMode change, null-aware `branch_id` predicate | TRUE |
| Phase 4 cache/usage keying | `ai_insights_cache_scope_idx` present, old `ai_insights_cache_org_user_type_biz_idx` gone; `ai_usage_logs` has organization/business/branch/user/app_key + `ai_usage_logs_scope_idx`; `UsageScope` threaded through every `logUsage` call site | TRUE |
| Guard suite + typecheck | `bunx vitest run src/__tests__/architecture.ai-conversation-scope.test.ts` → 7 passed | TRUE |

### New defects found during verification (added to the roadmap)

1. **Branch narrowing fails open.** `applyScope` in `dataTools.ts` narrows by branch only when `!isAdmin && accessibleBranchIds?.length`. A non-admin with **zero** branch assignments therefore reads every branch. Same fail-open in `getFinancialContext` (`if (!isAdmin && branchIds.length > 0)`).
2. **`businessId` / `branchId` are trusted from the request body.** Membership is verified for `organizationId` only. A member of the tenant can name any business or branch of that tenant and the tool loop scopes to it.
3. **No capability check on tools** — `executeDataTool` reaches every table in `DATA_TABLES` regardless of installed apps or module permissions. This is Phase 5, still unstarted; confirmed absent (`rg` finds no permission call in `dataTools.ts`).
4. **`ai_insights_cache` RLS has no tenant predicate** — policies are `auth.uid() = user_id` only. Correct scoping exists exclusively in the hook, i.e. the isolation is client-enforced at the database layer. A user who belongs to two tenants is the exposure path.

## Phase status

- Phase 1 — conversation storage & isolation: **DONE (verified)**
- Phase 2 — server-owned history & working context: **DONE (verified)**
- Phase 3 — client trust reduction & conversation list: **DONE (verified)**
- Phase 4 — AI cache & usage scope keying: **DONE (verified)**
- Phase 4b — authorization hardening: **DONE**
- Phase 5 — tool/capability scope: **DONE**
- Phase 6 — record-scoped threads: **DONE** (record threads are creator-private,
  null-aware separated from scope threads, and the "This record" mode only appears
  when the route identifies a record; shared/team threads remain out of scope)
- Phase 7 — background jobs: **PENDING (next)**

## Phase 4b — Authorization hardening (do first; Phase 5 builds on it)

- Add a single server-side `resolveCallerScope()` in the edge function that returns the
  authoritative `{ organizationId, businessId, branchId, accessibleBranchIds, role, isAdmin }`.
- Validate the requested `businessId` against the caller's memberships; on mismatch return 403
  rather than silently widening.
- Validate the requested `branchId` against `accessibleBranchIds` for non-admins; on mismatch 403.
- Make branch narrowing **fail closed**: a non-admin with no viewable branches gets an empty
  branch set, and any branch-scoped table returns zero rows instead of everything.
- Apply the same fail-closed rule inside `getFinancialContext`.
- Add tenant + branch predicates to `ai_insights_cache` RLS (`organization_id` membership and
  branch accessibility) so the database, not the hook, is the boundary.
- Extend the ratchet test: no `!isAdmin && ...length > 0` fail-open pattern in the assistant
  function or `dataTools.ts`.

## Phase 5 — Tool / capability scope

- Server-derive the allowed capability set from installed apps (`user_has_app_access`) and
  `user_has_module_permission(_user_id, _org_id, _business_id, _module, _operation)` — both
  already exist in the database.
- Map every entry of `DATA_TABLES` and every tool in `buildDataToolSpecs()` to a
  `{ app, module, operation: 'read' }` requirement; a table with no mapping is unreachable
  (deny by default).
- Filter the tool specs sent to the model by that set, so the model is never told about a
  capability it cannot use.
- Re-check the requirement **inside `executeDataTool` on every invocation**, not once per
  conversation, and independently of the conversation's `app_key` — cross-application
  reasoning stays allowed when authorized.
- An unpermitted or unknown tool returns a structured refusal object
  (`{ error: 'not_permitted', module }`) that the model can explain; it must not abort the turn.
- Cache the capability set per request only, never across requests or in the conversation row.
- Ratchet test: every branch of `executeDataTool` passes through the capability gate, and no
  tool handler queries a table absent from the requirement map.

## Phase 6 — Record-scoped threads

- Surface `record_type` / `record_id` threads on record pages; creator-private.
- Shared/team threads stay out of scope until explicitly requested.

## Phase 7 — Background jobs

- Any scheduled AI job carries the full scope tuple and re-derives permissions server-side
  rather than inheriting a user's UI state.

## Do NOT change

- Server-side auth/tenant/branch derivation, the single `ai-assistant` endpoint, cross-application
  reasoning when authorized, provider resolution/entitlements/streaming protocol, and all
  accounting business logic.

## Technical notes

- Migrations follow create → grant → RLS → policy order.
- Each phase ends with `bunx vitest run src/__tests__/architecture.ai-conversation-scope.test.ts`
  and `bunx tsgo --noEmit -p tsconfig.app.json`.
- Update this file at the end of each phase.

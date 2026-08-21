# AI Conversation Scope, Context & Multi-Tenant Isolation — Live Status

Authoritative status for the wave defined in
`.lovable/plan/ai-conversation-scope-context-multi-tenant-isolation-audit-r-2026-08-21.md`
(sections 3, 4 and 6 of that document remain the architectural contract).

## Currently active phase

Phase 3 is **complete**. Phase 4 (AI cache & usage scope keying) is the next
milestone and has **not** been started.

## Phase status

### Phase 1 — Conversation storage & isolation (DONE)
- `ai_conversations` and `ai_conversation_messages` created with the scope
  columns from the audit: `organization_id`, `business_id`, `branch_id`,
  `app_key`, `module_key`, `record_type`, `record_id`, `scope_level`,
  `created_by`, `title`, `last_message_at`, `archived_at`.
- GRANTs, RLS, and security-definer helpers
  `can_access_ai_conversation_scope` / `can_read_ai_conversation` in place.
- Messages denormalise `organization_id` so message RLS does not depend on a
  join.

### Phase 2 — Server-owned history & working context (DONE)
- `supabase/functions/ai-assistant/index.ts` gates on `can_read_ai_conversation`
  before loading the last 40 turns from the database.
- Only the newest user turn is trusted from the client when a thread exists.
- User turn is persisted before the provider call; assistant turn is persisted
  by a tee'd `TransformStream` when the stream completes.
- `src/lib/ai/workingContext.ts` derives `appKey` / `moduleKey` /
  `recordType` / `recordId` from the route and sends it as an explicit
  `workingContext` object (presentation grounding only, never authorization).
- `src/hooks/useAIConversation.ts` binds a thread to
  `(organization, business, branch|company, app_key)`; switching any of them
  rebinds and reloads that scope's own history — no cross-scope bleed.
- `src/components/ai/AIAssistantChat.tsx` shows the working context and a
  branch vs. company-wide scope toggle.

### Phase 3 — Client trust reduction & conversation list (DONE)
- Client no longer declares its own authorization: `userRole` and
  `accessibleBranchIds` removed from `useAIAssistant.ts` and from the
  `AIRequest` contract in the edge function. Role and accessible branches are
  derived server-side from the JWT.
- Conversation list: newest 20 non-archived threads per scope, plus
  `selectConversation` / `startNewConversation` (threads created lazily on first
  send). Chat header has a history popover, new-chat and archive actions.
- In-flight scope switches are guarded by a scope key.
- Ratchet test: `src/__tests__/architecture.ai-conversation-scope.test.ts`.

**Verified:** guard suite passing, `tsgo` typecheck of `tsconfig.app.json` clean.

### Phase 4 — AI cache & usage scope keying (DONE — this pass)
- Migration: `ai_insights_cache` gained `branch_id` and `app_key`; the old
  `ai_insights_cache_org_user_type_biz_idx` unique index was replaced with
  `ai_insights_cache_scope_idx` over
  `(organization_id, user_id, insight_type, COALESCE(business_id), COALESCE(branch_id), COALESCE(app_key))`.
  `ai_usage_logs` gained `organization_id`, `business_id`, `branch_id`,
  `user_id`, `app_key` plus a scope index; `ai_advisory_usage` gained `app_key`.
- `src/hooks/useAIInsightsCache.ts` rewritten: accepts `appKey` and
  `scopeMode` ("branch" default / "company"), applies the full null-aware scope
  tuple to every select/delete via a shared `applyScope` helper, keeps the
  delete-then-insert path aligned with the new unique index, resets displayed
  content on any scope change, and cancels in-flight loads on scope switch so a
  late response cannot paint another scope's cache.
- Edge function: added a server-derived `UsageScope`
  (organization / business / branch / user / app_key, taken from the JWT-derived
  values and `workingContext.appKey`, never from client authorization claims)
  and threaded it through `makeAIRequest`, `runDataToolLoop` and every
  `logUsage` call site, including the rate-limit, credits-exhausted and
  provider-error paths.
- Ratchet test extended: cache hook must carry organization + branch + app
  predicates (null-aware), no browser module may query `ai_insights_cache`
  without an organization predicate, and usage logs must be written from the
  server-derived scope tuple.

**Verification performed:** `bunx vitest run
src/__tests__/architecture.ai-conversation-scope.test.ts` (7 tests passing) and
a full `tsgo --noEmit -p tsconfig.app.json` typecheck (clean). Migration applied
successfully; the linter findings reported afterwards are pre-existing project
wide items (security-definer views/functions, leaked-password protection) and
were not introduced by this migration.

## Pending work (in roadmap order)

### Phase 5 — Tool/capability scope (NEXT)
- Derive the assistant's allowed tool list server-side from installed apps plus
  `user_has_module_permission`, checked per tool invocation rather than once per
  conversation, and independent of the conversation's `app_key`.
- Deny-by-default: an unknown or unpermitted tool name must return a structured
  refusal to the model, not an error that aborts the turn.
- Extend the ratchet test so no tool handler can execute without a permission
  check.

### Phase 6 — Record-scoped threads & sharing
- Surface record-scoped conversations (`record_type` / `record_id`) on record
  pages; keep them creator-private. Shared/team threads stay out of scope until
  explicitly requested.

### Phase 7 — Background jobs
- Any scheduled/background AI job must carry the same scope tuple and re-derive
  permissions instead of inheriting a user's UI state.

## Instructions for the next agent

1. **Verify Phase 4 before writing new code.** Confirm
   `ai_insights_cache_scope_idx` exists and the old
   `ai_insights_cache_org_user_type_biz_idx` is gone; confirm `ai_usage_logs`
   has the five scope columns. Run
   `bunx vitest run src/__tests__/architecture.ai-conversation-scope.test.ts`
   and `bunx tsgo --noEmit -p tsconfig.app.json`. Then exercise the insight
   widgets: generate an insight in branch A, switch to branch B, and confirm the
   widget is empty rather than showing branch A's content; switch back and
   confirm the original is restored. Send an assistant turn and confirm the new
   `ai_usage_logs` row carries organization / business / branch / user.
2. Only after that verification, start **Phase 5** exactly as scoped above. Do
   not begin Phase 6+ or unrelated domains while Phase 5 is partially done.
3. Keep the audit's "Do NOT change" list intact: server-side auth/tenant/branch
   derivation, the single `ai-assistant` endpoint, cross-application reasoning
   when authorized, provider resolution/entitlements/streaming protocol, and all
   accounting business logic.
4. Update this file at the end of each phase so it stays the authoritative
   status record.


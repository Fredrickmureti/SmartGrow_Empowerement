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

### Phase 3 — Client trust reduction & conversation list (DONE — this pass)
- Client no longer declares its own authorization: `userRole` and
  `accessibleBranchIds` removed from `useAIAssistant.ts` and from the
  `AIRequest` contract in the edge function, so no future handler can read them.
  Role and accessible branches remain derived server-side from the JWT.
- Conversation list added: `useAIConversation` now returns the newest 20
  non-archived threads for the active scope, plus `selectConversation` and
  `startNewConversation` (thread rows are still created lazily on first send so
  navigation never litters the list with empty threads).
- `useAIAssistant` exposes `conversations`, `conversationId`, `newChat`,
  `openConversation`; `clearChat` still archives.
- Chat header gained a history popover (thread list, active thread
  highlighted), a new-conversation action, and kept the archive action.
- In-flight scope switches are guarded by a scope key so a late query cannot
  paint another scope's history.
- Ratchet test added: `src/__tests__/architecture.ai-conversation-scope.test.ts`
  — no client-declared role/branch, no `AIRequest` role/branch fields, every
  browser conversation query is tenant- or thread-scoped, and the hook binds
  turns to a persisted conversation.

**Verification performed:** `bunx vitest run` on the two AI architecture guard
suites (7 tests passing) and a full `tsgo` typecheck of `tsconfig.app.json`
(clean).

## Pending work (in roadmap order)

### Phase 4 — AI cache & usage scope keying (NEXT)
- `ai_insights_cache` is keyed on `(organization_id, user_id, insight_type,
  business_id)` only. Add `branch_id` (nullable = company-wide) and, where
  meaningful, `app_key`, with a migration that also replaces the
  `ai_insights_cache_org_user_type_biz_idx` unique index.
- Update `src/hooks/useAIInsightsCache.ts` to read/write the branch dimension
  and to keep the delete-then-insert path aligned with the new unique index.
- Key `ai_usage_logs` / `ai_advisory_usage` rows on the same scope tuple.
- Extend the ratchet test: no cache query without an `organization_id`
  predicate and, when branch-scoped, without a `branch_id` predicate.

### Phase 5 — Tool/capability scope
- Derive the assistant's allowed tool list server-side from installed apps plus
  `user_has_module_permission`, checked per tool invocation rather than once per
  conversation, and independent of the conversation's `app_key`.

### Phase 6 — Record-scoped threads & sharing
- Surface record-scoped conversations (`record_type` / `record_id`) on record
  pages; keep them creator-private. Shared/team threads stay out of scope until
  explicitly requested.

### Phase 7 — Background jobs
- Any scheduled/background AI job must carry the same scope tuple and re-derive
  permissions instead of inheriting a user's UI state.

## Instructions for the next agent

1. **Verify Phase 3 before writing new code.** Confirm that
   `rg "accessibleBranchIds" src` returns nothing, that the `AIRequest`
   interface in `supabase/functions/ai-assistant/index.ts` still has no
   role/branch fields, and that
   `bunx vitest run src/__tests__/architecture.ai-conversation-scope.test.ts`
   passes. Then exercise the panel end-to-end: send a turn in two different apps
   and two different branches, reload, and confirm each scope restores only its
   own thread and that the history popover lists that scope's threads only.
   Confirm the new-conversation action produces a second thread rather than
   reusing the first, and that archive removes it from the list.
2. Only after that verification, start **Phase 4** exactly as scoped above.
   Do not begin Phase 5+ or unrelated domains while Phase 4 is partially done.
3. Keep the audit's "Do NOT change" list intact: server-side auth/tenant/branch
   derivation, the single `ai-assistant` endpoint, cross-application reasoning
   when authorized, provider resolution/entitlements/streaming protocol, and all
   accounting business logic.
4. Update this file at the end of each phase so it stays the authoritative
   status record.

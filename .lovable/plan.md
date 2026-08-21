# AI Conversation Scope, Context & Multi-Tenant Isolation — Audit & Recommendation

## 1. Verdict

The current behavior is architecturally incorrect, but not for the reason it appears. The assistant has **no conversation persistence at all**: messages live only in React state inside a single `useAIAssistant()` instance mounted globally, so an Inventory thread follows the user into Banking simply because nothing ever scopes, stores, or resets it. The same defect means the thread also survives an organization (tenant) switch, a business/entity switch, and a branch switch inside the same browser session — the in-memory history is then replayed verbatim to the model under the *new* tenant's server-derived scope. Data retrieval itself is correctly scoped server-side (JWT-derived org membership, DB-derived role and branch assignments; body-supplied role/branches are explicitly ignored), so this is a conversation-state leak, not a data-access leak. Carrying an Inventory thread into Banking is also wrong product behavior: enterprise assistants keep one conversation store and change the *working context*, they do not silently reuse a stale thread as the answer context for a different application. The fix is not a table per app and not one global conversation. It is unified conversation storage with explicit scope columns plus a separately-transmitted working context. Conversation visibility must be authorized server-side by tenant/company/branch, independently of what the UI currently displays.

## 2. What modern enterprise systems actually do

| System | Conversation history scope | Working context | Cross-app reasoning | Tenant/entity boundary |
| --- | --- | --- | --- | --- |
| Microsoft Dynamics 365 / Copilot | Documented: conversation is a first-class stored object; app/page/record context is passed *separately* as application context and context variables, not inferred from the thread | Documented: current form/record passed explicitly per turn | Documented as permitted within the user's security roles | Documented: Dataverse security roles + tenant boundary enforced server-side |
| NetSuite / Oracle | Inference: assistant surfaces are role- and subsidiary-scoped; no public doc found stating thread scoping | Inference | Inference | Documented in general: subsidiary/role restrictions govern all data access |
| Intuit / QuickBooks Intelligence | Inference: per-company-file assistant; no public doc found on thread scope across modules | Inference | Inference | Documented in general: company file is the isolation unit |
| Odoo | Inference: AI features attach to the active record/discuss thread; no reliable current doc found on cross-app thread carryover | Inference | Inference | Documented in general: multi-company record rules govern access |

Only the Microsoft row is documented behavior; the rest is architectural inference and is labelled as such.

## 3. Recommended architecture for this ERP

- Adopt **unified conversation storage + explicit conversation scope + working context + authorization scope + optional global scope**. Reject per-app tables and reject one global conversation.
- Two tables only: `ai_conversations` and `ai_conversation_messages`.
- `ai_conversations` scope columns: `organization_id` (tenant, required), `business_id` (company/entity, nullable = company-wide), `branch_id` (nullable = cross-branch), `app_key`, `module_key`, `record_type`, `record_id`, `scope_level` (`record | module | app | company | tenant`), `created_by`, `title`, `last_message_at`.
- Messages carry `conversation_id`, `role`, `content`, `organization_id` (denormalized for RLS), and the working context snapshot at the time of the turn.
- **Working context is not conversation scope.** The client keeps sending the current route/app/module/record each turn (today only `currentPage` is sent); it selects and augments a conversation, it never widens data access.
- Conversation selection key on navigation: `(organization_id, business_id, branch_id, app_key)` for the default per-app thread; a record-scoped thread additionally keys on `record_type/record_id`.
- Navigating apps switches the *active* conversation; it never renames or reuses the previous one.
- Returning to a previous app restores that app's most recent conversation for the same tenant/company/branch.
- Switching tenant, company, or branch must hard-reset the in-memory thread before the next request is built.
- Add an explicit **Business/global scope** the user opts into (`scope_level = 'company'` or `'tenant'`), surfaced as a visible mode in the chat header — this is how "company-wide view of inventory, sales and cash" is asked deliberately.
- Cross-application reasoning stays allowed inside one conversation; it is governed by authorization and tool scope, not by which app the panel was opened from.
- Keep the existing server-side derivation of role and accessible branches from the JWT — it is the correct pattern and must extend to conversation reads/writes.
- Stop trusting the client-supplied `messages[]` array as the sole history: load history server-side from the conversation id, and validate that the caller may read that conversation.
- The client may send only the new user turn plus the conversation id.
- Tool/capability scope becomes an explicit server-side list derived from installed apps + `user_has_module_permission`, independent of the conversation's `app_key`.
- Any AI cache (`ai_insights_cache`) and usage rows must key on the same scope tuple so a cached answer cannot cross tenant, company, or branch.
- Titles and AI-generated summaries are tenant data and live under the same RLS as messages.
- Migration: no back-fill — existing behavior has no persisted history to migrate.
- Scenario answers: A restore, B new Banking conversation (Inventory untouched), C restore original Inventory thread, D new Branch B conversation, E branch-specific by default with an explicit company-wide scope available, F allowed subject to authorization, G explicit global mode.

## 4. Multi-tenant / multi-branch rules

- Tenant: a conversation and its messages are readable only when `organization_id` matches an active `user_roles` row for the caller. Hard boundary, enforced in RLS **and** re-asserted in the edge function.
- Company/entity: `business_id` must be null (company-wide) or a business the caller can access; never a sibling entity.
- Branch: a branch-scoped conversation is visible only to users whose `user_branch_assignments` include that branch with `can_view`.
- Branch default: conversations created while a branch is active are branch-scoped and do **not** appear when the user switches to another branch, even when the user can access both.
- A user with access to both branches sees Branch B's conversations only after switching to Branch B, plus any company-wide-scoped conversations in both.
- Company-wide conversations (`branch_id IS NULL`) are visible from any branch the user may access within that company.
- Application: `app_key` filters which conversation is *offered* by default; it never grants or restricts data.
- Module/record: record-scoped conversations appear on that record and in the user's conversation list, subject to the tenant/company/branch rules above.
- Ownership: default to creator-private conversations; shared/team conversations are a later, explicit feature — not implicit.
- Global/company-wide AI mode is available only to users whose branch/company access already spans the requested scope; otherwise it silently narrows to their authorized scope and says so.
- Data-access scope for retrieval stays exactly as it is today: derived server-side from the JWT, never from the request body.
- AI capability scope is checked per tool invocation against module permissions, not once per conversation.
- No conversation, message, summary, cached context, or tool result may be selected by a query that lacks an `organization_id` predicate.
- Frontend filtering is never the enforcement point for any of the above.
- Background/scheduled AI jobs must carry the same scope tuple and re-derive permissions, not inherit a user's UI state.

## 5. Current implementation findings

**Finding:** No AI conversation persistence exists.
**Evidence:** `src/hooks/useAIAssistant.ts` holds `messages` in `useState`; no `ai_conversations`/`ai_conversation_messages` tables appear in `src/integrations/supabase/types.ts`.
**Impact:** History is lost on reload and cannot be scoped or authorized; all scoping questions are currently unanswerable at the data layer.

**Finding:** A single global assistant instance spans the whole app.
**Evidence:** `src/App.tsx:893` mounts `<GlobalAIAssistant />` outside the route tree; `GlobalAIAssistant.tsx` passes only `location.pathname` down to `AIAssistantChat`.
**Impact:** The Inventory thread follows the user into Banking — the reported symptom.

**Finding:** The thread is not reset on tenant, company, or branch change.
**Evidence:** `useAIAssistant` reads `currentOrg`, `currentBusiness`, `currentBranch` only to build the request body; nothing clears `messages` when they change.
**Impact:** Messages authored under Tenant/Branch A are replayed to the model while the server context is Tenant/Branch B — a real cross-scope context bleed inside one session.

**Finding:** Conversation history is client-supplied.
**Evidence:** `sendChatMessage` posts the full `newMessages` array; the edge function reads `messages` straight from the body (`index.ts:1781`).
**Impact:** The prompt content is not authorized against the current scope; nothing server-side can detect stale or foreign context.

**Finding:** Data retrieval is correctly scoped server-side.
**Evidence:** `supabase/functions/ai-assistant/index.ts:1777-1834` ignores body-supplied `userRole`/`accessibleBranchIds`, verifies the bearer via `auth.getUser`, requires an active `user_roles` row for `organizationId` (403 otherwise), and derives branches from `user_branch_assignments`; every context query filters on `organization_id`.
**Impact:** No cross-tenant data-retrieval leak found on this path. The defect is conversation state, not data access.

**Finding:** Working context is passed but weakly.
**Evidence:** `currentPage` is appended to the system prompt at `index.ts:1917-1918`; no app/module/record identifiers are sent.
**Impact:** The model cannot reliably distinguish app or record context, and nothing keys a conversation to it.

**Finding:** The frontend still declares role/branch in the request body.
**Evidence:** `useAIAssistant.ts` sends `userRole` and `accessibleBranchIds`.
**Impact:** Currently harmless (server ignores them) but misleading; it invites a future handler to trust them.

## 6. Wave recommendation

Change:
- Add `ai_conversations` + `ai_conversation_messages` with the scope columns in section 3, GRANTs, RLS scoped by `organization_id`, business access, and branch assignment.
- Add a security-definer helper for "may this user read this conversation" and use it in RLS and in the edge function.
- Derive `app_key`/`module_key`/`record_type`/`record_id` from the current route in the client and send them as an explicit `workingContext` object.
- Select or create the active conversation from `(org, business, branch, app_key[, record])` on navigation and on scope change.
- Reset in-memory messages whenever org, business, or branch changes.
- Load history server-side from `conversation_id`; send only the new turn from the client.
- Persist user and assistant turns server-side after streaming completes.
- Add an explicit company-wide / business scope toggle in the chat header.
- Add a conversation list (per app, plus company-wide), with new-conversation action.
- Key `ai_insights_cache` and AI usage rows on the same scope tuple.
- Stop sending `userRole`/`accessibleBranchIds` from the client.
- Add architecture ratchet tests: no conversation query without an `organization_id` predicate; client never supplies role/branch; history is not the sole client-supplied prompt source.

Do NOT change:
- The existing server-side auth/tenant/branch derivation in `ai-assistant` — it is correct.
- The single `ai-assistant` endpoint (no per-app functions, no per-app tables).
- The ability of the assistant to reason across applications when authorized.
- Provider resolution, entitlement checks, or the streaming protocol.
- Any accounting/ERP business logic.

## 7. Implementation risk

- Cross-tenant exposure via a conversation list query missing the `organization_id` predicate — mitigate with RLS plus the ratchet test.
- Cross-branch exposure by defaulting `branch_id` to null on creation, silently making branch threads company-wide.
- Stale in-memory context surviving a scope switch (today's actual bug) reappearing after refactor.
- Incorrect conversation retrieval keying — two apps colliding on one thread, or every navigation spawning a new empty thread.
- Trusting `workingContext` for authorization rather than presentation only.
- AI tool authorization drifting from `user_has_module_permission` once tools are added.
- RLS on messages relying on a join to conversations without its own `organization_id` column (performance and correctness).
- Persisted AI summaries/titles escaping the same RLS.
- Backward compatibility: users mid-session when the change ships losing an in-flight thread (acceptable; nothing is persisted today).
- Cache poisoning across scopes if `ai_insights_cache` keys are not extended at the same time.

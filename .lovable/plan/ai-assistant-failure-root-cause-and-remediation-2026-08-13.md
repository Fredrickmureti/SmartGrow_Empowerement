# AI Assistant Failure — Root Cause and Remediation

## A. Exact root cause (evidence-backed)

The browser's CORS message is a symptom, not the cause. Direct probe of the live endpoint:

```text
OPTIONS https://<project>.supabase.co/functions/v1/ai-assistant
→ HTTP 404
   sb-error-code: NOT_FOUND_FUNCTION_BLOB
   {"code":"NOT_FOUND_FUNCTION_BLOB","message":"Requested function was not found"}
```

Same probe against known-good functions in this project:

```text
OPTIONS /functions/v1/render-document → 200
OPTIONS /functions/v1/send-email      → 200
OPTIONS /functions/v1/provider-run    → 200
OPTIONS /functions/v1/ai-generate-email → 404 NOT_FOUND_FUNCTION_BLOB
```

So: **`ai-assistant` (and `ai-generate-email`) exist in the working tree but have never been deployed to the edge runtime.** The gateway answers the preflight itself with 404 before any function code runs; a non-2xx preflight makes Chrome report "Response to preflight request doesn't pass access control check: It does not have HTTP ok status", and the subsequent POST never leaves the browser, producing `TypeError: Failed to fetch`.

This is Case C (function never reaches application code). It is **not** Case A/B/E/F: the source already handles `OPTIONS` correctly (`serve()` returns `corsHeaders` immediately for `OPTIONS`, before any auth), and the frontend request shape is fine.

## B. Current architecture (verified by reading the code)

```text
AIAssistant UI → useAIAssistant.sendChatMessage
  → raw fetch POST /functions/v1/ai-assistant  (Authorization: user JWT, apikey: anon)
  → edge fn ai-assistant
      OPTIONS short-circuit (CORS)
      auth gate: bearer required; service-role bearer allowed for server callers,
                 otherwise supabase.auth.getUser(bearer)
      tenant gate: user_roles row for (user, organizationId, is_active) else 403;
                 role + user_branch_assignments read server-side (body-supplied
                 userRole / accessibleBranchIds are explicitly ignored)
      entitlement check (billable AI features only; help chat always allowed)
      provider resolution: ai_providers / ai_api_keys rows, keys resolved from
                 Vault via get_ai_api_key_secret; virtual "lovable" attempt when
                 LOVABLE_API_KEY is set (it is set on this project)
      → provider API → SSE stream proxied back with CORS headers
```

Security review of what is deployed-in-source: no auth bypass, no tenant-isolation hole found, provider credentials stay server-side (env + Vault RPC), and the client-declared role is deliberately discarded. The one weakness is `Access-Control-Allow-Origin: *` — but that matches every other function in this codebase, and because the endpoint requires a bearer JWT and browsers don't send cookies here, it is not the defect and changing it in isolation would break the convention. Note the header list omits `x-client-info`-free callers is fine, but it does **not** list `apikey`… it does; no change needed.

## C. Remediation

1. **Deploy `ai-assistant` and `ai-generate-email`** to the edge runtime (this is the actual fix). Confirm the deployed blob answers `OPTIONS → 200` with CORS headers.
2. **If the deploy fails**, treat the deploy error as the next root cause and fix it (import resolution, size) rather than working around it — no new function, no duplicated code path.
3. **Error propagation** in `src/hooks/useAIAssistant.ts`: today any transport-level failure collapses into `toast.error("Failed to send message")`. Add a small structured error mapper so the UI distinguishes: endpoint unreachable/not deployed, 401 (session expired — sign in again), 403 (no access to this workspace / not entitled), 503 (AI not configured or provider unavailable), 429/402, and unexpected. Keep server detail in `console.error`, never surface raw provider text or stack traces to users.
4. **No other behavioural change**: no origin loosening, no auth removal, no client-side provider calls, no parallel AI implementation. `ai-generate-email` and `ai-assistant` stay the two canonical AI endpoints.

## D. Tests and guards

- `supabase/functions/ai-assistant/index.test.ts` (Deno, existing test conventions): `OPTIONS` returns 2xx with `Access-Control-Allow-Origin`; POST with no `Authorization` returns 401 JSON with CORS headers; POST with a valid anon-only bearer for an org the caller doesn't belong to returns 403.
- Frontend unit test for the new error mapper: fetch rejection → "assistant is unavailable" style message (not a silent generic), 401/403/503 → their specific messages.
- Architecture guard (Vitest, alongside the existing `src/test/architecture/*` guards): no browser-side module may reference an AI provider base URL or an AI API-key env var, and `ai-assistant` must remain the single client entry point for assistant chat.

## E. Verification evidence to produce

- `curl -i -X OPTIONS .../ai-assistant` → 200 + CORS headers (currently 404).
- `curl -i -X POST` with no auth → 401 JSON with CORS headers.
- Signed-in browser run against `localhost:8080`: Network tab shows `OPTIONS 200` then `POST 200` streaming, assistant replies in the UI; edge function logs show the auth/tenant/provider path.
- Same endpoint/config path is what production uses (same function, same origin policy), so no environment-specific branch is introduced.

## Technical notes

- No database migration is required.
- `LOVABLE_API_KEY` is present on this project, so the assistant's built-in provider path will work as soon as the function is deployed, even with no `ai_providers` rows.

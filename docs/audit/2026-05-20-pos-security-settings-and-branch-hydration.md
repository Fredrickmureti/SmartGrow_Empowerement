# POS security settings save failure + "No branch selected" hydration flicker

_Verdict date: 2026-05-20._

## Issue 1 — `upsert_pos_security_settings` → 404 then `42P01`

### Root cause

`public.upsert_pos_security_settings` (added during Stage 8.5) checked
caller membership against `public.user_organizations`, a table that has
never existed in this schema. The May 17 verdict fixed the same drift in
two trigger functions but the new RPC reintroduced it.

The browser saw two symptoms in sequence:

1. `POST /rest/v1/rpc/upsert_pos_security_settings → 404` — PostgREST's
   schema cache went stale after the function raised during introspection.
2. `42P01 relation "public.user_organizations" does not exist` — surfaced
   once the cache reloaded and the function body actually executed.

### Fix

`CREATE OR REPLACE public.upsert_pos_security_settings(...)` with the
membership predicate rewritten against `public.user_roles` (canonical).
Company-default rows (`p_branch_id IS NULL`) require an org admin
(`role IN ('owner','admin','super_admin')`, `is_active = true`).
Per-branch overrides additionally check
`public.user_can_access_branch(v_uid, p_branch_id)`. Signature is
unchanged so the existing client call site needs no edits.

`NOTIFY pgrst, 'reload schema';` is issued at the end of the migration to
drop the stale 404 immediately.

### Verification

```sql
SELECT pg_get_functiondef('public.upsert_pos_security_settings'::regproc)
       ~* '\muser_organizations\M';                                 -- false

SELECT n.nspname||'.'||p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE pg_get_functiondef(p.oid) ~* '\muser_organizations\M'
  AND p.proname <> 'get_user_organizations';                         -- 0 rows
```

UI: `/pos/settings?tab=security` → toggle "Lock after inactivity" → Save
succeeds, no 404, no `42P01`.

### Not done (intentional)

- No `public.user_organizations` alias view. Aliasing entrenches drift;
  the May 17 verdict already rejected it.
- No client-side retry, no error swallowing, no schema change.

---

## Issue 2 — "No branch selected" flicker on POS reload

### Root cause

`POSShellLayout` gated the subtree on `useBranch().isLoading` alone.
`BranchContext.fetchBranches` flipped `isLoading=false` on its
`!currentBusiness` early return, lying about readiness while
`BusinessContext` was still hydrating. Reload timeline:

```text
t0  Auth → user appears
t1  Session → currentOrg appears              (currentBusiness still null)
t2  fetchBranches runs → "no business" branch → isLoading=false
    └── Gate opens → ActiveBranchBadge renders destructive
        "No branch selected" chip for one frame
t3  Business hydrates → fetchBranches re-runs → isLoading=true → fetch
    → currentBranch set → isLoading=false
```

### Fix

Two coordinated changes — no delays, no CSS hiding, no force reloads:

1. `BranchContext.isLoading` is honest. While `orgLoading || businessLoading`,
   `fetchBranches` does NOT flip `isLoading` false. Terminal states
   (no auth/org, or no business after business context has settled) still
   flip false so branch-critical surfaces can render their own empty UI.

2. New `usePOSContextReady()` returns the **conjunction** of every
   dependency POS surfaces rely on: auth, org, business, branch. POS shell
   layouts render their loading fallback until `ready === true`. The
   destructive "No branch selected" branch in `ActiveBranchBadge` is
   therefore unreachable during hydration; it can only paint after every
   upstream is hydrated AND a branch is genuinely absent (terminal "no
   branch access" state).

This matches how Lightspeed X-Series, Toast, and Square for Restaurants
gate their POS shells: a single readiness predicate composed of every
branch-critical context, with per-context `isLoading` honesty as the
invariant the predicate depends on.

### Architectural rule (added to plan / memory)

> Branch-critical surfaces MUST gate on a single readiness predicate
> (`usePOSContextReady` for POS). They MUST NOT read a single context's
> `isLoading` in isolation, because hydration order between sibling
> contexts is not guaranteed. Every per-context `isLoading` exposed by
> the app must remain `true` until the context has either fully fetched
> or reached a terminal state.

### Verification

- Hard reload `/pos`, `/pos/settings`, `/pos/terminal/:id` with throttled
  network. Topbar chip transitions `Loading branch… → <BranchName>` with
  no intermediate destructive chip.
- No branch-scoped query fires with `branchId=null` followed by a refetch
  with the resolved id (eliminated by the shell gate).

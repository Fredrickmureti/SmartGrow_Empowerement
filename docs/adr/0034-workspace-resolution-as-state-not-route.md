# ADR-0034: Workspace resolution is state, not a route

- Status: Accepted
- Date: 2026-06-03
- Related: ADR-0004 (platform admin vs tenant), ADR-0019 (workspace governance plane)

## Context

For months, signed-in users reloading any page (`/home`, `/sales/invoices`, …)
saw the URL briefly flip to `/select-organization?returnTo=…` before settling
on the intended destination. Single-org users — the majority — were routed
through a workspace-picker URL even though there was nothing to pick.

The root cause was structural, not cosmetic:

1. Workspace-readiness logic was duplicated across `OnboardingGuard`,
   `SubscriptionProtectedRoute`, and `OnboardingGate`. Each guard
   independently inspected `authLoading`, `sessionLoading`, and the org list,
   and each independently decided to `<Navigate to="/select-organization">`
   when its local view of the session was "not yet ready".
2. The "active workspace" preference (`last_org_id`) was client-only
   (`localStorage`). On a fresh tab, before localStorage was rehydrated,
   guards could not tell "user has one org" from "I haven't looked yet" and
   defaulted to the picker.
3. The picker page itself had a 250 ms `settled` timer plus a sibling-tab
   interval leader-probe — both existed to recover from being landed on by
   accident, which reinforced the bad habit of treating the URL as a place
   to park loading bookkeeping.

Compared to mature multi-tenant SaaS (Google Workspace, Slack, Notion, Jira,
Salesforce, Xero, QuickBooks), exposing `/select-workspace` as an
intermediary URL for single-tenant users is non-standard and erodes trust
that the URL bar reflects where the user actually is.

## Decision

**The URL represents user intent. Workspace readiness is state, resolved
before render, and never rewritten into the URL.**

Concretely:

1. **One selector.** `src/hooks/useWorkspaceRouting.ts` returns a
   discriminated union:

    ```text
    { status: "loading" }
    { status: "no-orgs" }            // 0 memberships, onboarding complete
    { status: "needs-onboarding" }   // 0 memberships, onboarding not complete
    { status: "needs-picker" }       // >1 orgs, no last_org_id, no intendedPath
    { status: "ready", orgId }
    ```

    All route guards (`OnboardingGuard`, `SubscriptionProtectedRoute`,
    `OnboardingGate`) consume this hook and become pure renderers:
    `loading → <BrandedLoader/>`, `no-orgs → <NoWorkspaceEmptyState/>` (in
    place — URL untouched), `needs-onboarding → <Navigate
    to="/onboarding-setup">` (legitimate intent), `ready → children`. No
    guard `<Navigate>`s to `/select-organization`.

2. **Server-trusted active workspace.** `profiles.last_org_id` is the
   canonical store. `get_user_session_data` returns it alongside the
   membership list in one round-trip, stripping the id if the membership
   no longer exists. `switchOrganization` writes through the
   `set_last_org_id` RPC. `localStorage` remains as an offline-first
   fallback only.

3. **Picker page only honours intent.** `SelectOrganization` no longer
   contains the 250 ms `settled` timer or the sibling-tab interval probe.
   It is reachable only by:
   - explicit "Switch workspace" click in the topbar, or
   - the one-shot `flowRouter` / `postLoginRedirect` resolver concluding
     post-sign-in that the user has >1 orgs and no `last_org_id`.

4. **Guardrails.**
   - ESLint rule `local/no-navigate-for-loading-state` bans
     `<Navigate to="/select-organization">` and
     `navigate("/select-organization", …)` (and `router.navigate({ to:
     "/select-organization" })`) outside a tight allowlist
     (`SelectOrganization`, `WorkspaceRecoveryCard`,
     `NoWorkspaceEmptyState`, `flowRouter`, `postLoginRedirect`).
   - Architecture test
     `src/test/architecture/no-redirect-to-picker.test.ts` asserts the same
     invariant in CI.

## Consequences

Positive:

- Single-org users never see `/select-organization` in the URL — even
  momentarily on reload, deep-link, or wake-from-sleep.
- Multi-org users with a server-known `last_org_id` reload into the right
  workspace without picker churn.
- Guards are simple renderers; readiness logic has exactly one home and
  one set of tests.
- Stale localStorage (org deleted, user removed) is corrected server-side
  before the payload reaches the client; no client-side recovery dance.

Negative / accepted:

- One extra column (`profiles.last_org_id`) and one new RPC
  (`set_last_org_id`).
- Future guards must remember to call `useWorkspaceRouting()` rather than
  reimplement readiness. The ESLint rule plus the arch test exist to make
  the wrong way fail loudly.

## Alternatives considered

- **Keep guards independent, just stop redirecting.** Rejected — the
  duplication was the bug. Three sources of truth for readiness will
  diverge again.
- **Resolve workspace fully on the server with SSR session hydration.**
  Out of scope for this stack today; the server-trusted `last_org_id` +
  selector pattern captures most of the benefit without an SSR rewrite.
- **Put the picker behind a modal instead of a route.** Doesn't solve the
  underlying readiness-duplication problem and breaks the rare legitimate
  deep-link to "switch workspace".

## Enforcement

- `eslint-rules/no-navigate-for-loading-state.js` (error-level)
- `src/test/architecture/no-redirect-to-picker.test.ts` (runtime)
- `src/hooks/useWorkspaceRouting.ts` (single readiness selector)

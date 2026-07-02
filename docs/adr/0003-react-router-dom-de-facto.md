# ADR 0003 — React Router DOM is the De-Facto Router; TanStack Start Metadata Is Informational

- **Status**: Accepted
- **Date**: 2026-04-23
- **Deciders**: Inventory architecture audit
- **Supersedes**: —
- **Superseded by**: —

## Context

The project's environmental metadata describes a **TanStack Start v1** stack
with file-based routing in `src/routes/`, server functions, and SSR via the
TanStack Vite plugin.

The actual codebase uses **`react-router-dom`** with `BrowserRouter` /
`HashRouter` declared in `src/App.tsx` and a per-app route table in
`src/apps/<app>/routes.tsx` (e.g. `src/apps/inventory/routes.tsx`). The pages
live in `src/pages/`. There are no files in `src/routes/`, no
`__root.tsx`, no `routeTree.gen.ts`, and no `createServerFn` calls.

This is not a runtime defect — `react-router-dom` works fine in the Vite
dev server and the bundled output. It is **architectural drift** from the
declared stack.

## Decision

For the foreseeable future, **`react-router-dom` is the canonical router** of
this codebase. New pages and apps are added to `src/apps/<app>/routes.tsx`
following the existing pattern (lazy-loaded `Route` elements wrapped in
`SubscriptionProtectedRoute` and module gates).

We do **not** maintain TanStack Start route files in parallel. Mixing the two
is worse than picking one — the bundler would split the route trees and the
type-safe `<Link>` benefits of TanStack would only apply to half the app.

The TanStack Start metadata in the project description is treated as
**informational**: it accurately names the framework category (Vite + React
+ SSR-capable) but does not bind the routing implementation.

## Consequences

### Accepted

- Zero migration cost today. Every existing module continues to work.
- Familiar mental model for contributors who know React Router v6.
- `SubscriptionProtectedRoute`, `WarehouseScopeGate`, `BranchScopeGate`,
  `CompanyScopeGate`, and `ModuleGate` all compose naturally as React Router
  route elements.

### Sacrificed

- **No file-based routing.** Adding a new page requires editing
  `src/apps/<app>/routes.tsx` instead of just dropping a file in
  `src/routes/`.
- **No type-safe `<Link to="/...">`.** Typos in route paths are runtime
  errors, caught only by manual click-through or e2e tests.
- **No per-route `head()`.** SEO/`<title>` per route uses ad-hoc
  `useEffect` + `document.title` patterns instead of TanStack's declarative
  head API.
- **No native SSR.** The app ships as a pure client-side SPA. First paint
  shows a loading skeleton.

### Risks

- A future contributor reading the environment metadata may attempt to add
  TanStack route files and discover they are never registered. This ADR is
  the canonical reference to redirect them.
- If we later need real SSR (e.g. for SEO of marketing pages), this is a
  full migration project, not a feature flag. Budget two to four weeks and
  treat the migration as a separate workstream — do not interleave it with
  feature work.

## Alternatives considered

1. **Migrate to TanStack Start now.** Rejected — the codebase has 80+ route
   files across 10+ apps, all wrapped in custom gate components. The
   migration is mechanical but extensive, and the inventory audit does not
   block on routing.
2. **Document TanStack as the target and freeze new React Router routes.**
   Rejected — would create a hybrid codebase where some new features land in
   one router and some in the other; the worst of both worlds.

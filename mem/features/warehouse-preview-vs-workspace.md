---
name: Warehouse previews vs entity workspaces (ADR 0122)
description: Rule that warehouse side panes are read-only EntityPreview peeks and all editing/config/history lives on EntityWorkspaceShell routes (location, packaging, yard visit, plate cockpit).
type: feature
---

# ADR 0122 — preview vs workspace in the Warehouse app

Two primitives in `src/features/warehouse/entity/`:

- `EntityPreview` — read-only side pane: identity, state, ≤4 metrics, open work,
  one-click acts (print/clear/block). No inputs, no tabs, no dialogs. Must pass
  `workspaceHref`.
- `EntityWorkspaceShell` — full-width object page over `RecordShell`, tabbed,
  active tab in `?tab=`, lazy tab bodies.

Selection is addressable via `useEntitySelection` → `?sel=<id>`.

Workspace routes: `/warehouse-app/layout/location/:id`,
`/warehouse-app/packaging/:id` (+ `/new`), `/warehouse-app/yard/visit/:id`,
`/warehouse-app/plates/:id` (pre-existing cockpit).

Preview-sufficient: appointments, tasks, exceptions — transient work items.

`LocationInspector.tsx` deleted; `TrailerVisitDrawer` is now a preview and its
former body is `TrailerVisitBody.tsx`.

Enforced by `src/test/architecture/warehouse-preview-vs-workspace.test.ts`.

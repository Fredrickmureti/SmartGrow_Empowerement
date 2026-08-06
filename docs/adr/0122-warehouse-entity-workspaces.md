# ADR 0122 — Warehouse previews vs entity workspaces

Status: Accepted (2026-08-05)
Extends: ADR 0079 (Inventory vs Warehouse split), ADR 0104 (layout digital twin),
ADR 0105 (packaging master), ADR 0086 (yard), ADR 0121 (warehouse IA)

## Context

Several Warehouse boards had grown a side pane that was, in effect, a second
application: `LocationInspector` (293 lines) authored master data and
configuration for a bin inside a 420px column; the packaging catalogue put a
four-tab record — specification form, carrier rules, availability, activity —
next to its own list; `TrailerVisitDrawer` (520 lines) drove the whole yard
state machine plus two audit trails inside a sheet. Meanwhile the handling-unit
board had the opposite defect: no peek at all, so every question meant leaving
the board.

Mature WMS products (SAP EWM, Oracle WMS, Manhattan, Blue Yonder, Dynamics 365
SCM, Odoo) all separate the two interactions. A *monitor* answers "what is this
and what do I do about it right now" in place; the *object page* owns master
data, configuration and history at full width.

## Decision

Two primitives, one rule each.

| Primitive | File | Contract |
|---|---|---|
| `EntityPreview` | `src/features/warehouse/entity/EntityPreview.tsx` | Read-only. Identity, state, ≤4 metrics, open work, immediate one-click acts (print, clear, block). No form fields, no tabs, no configuration. Always exposes `workspaceHref`. |
| `EntityWorkspaceShell` | `src/features/warehouse/entity/EntityWorkspaceShell.tsx` | Full-width object page over the platform `RecordShell`/`RecordHeader`, tabbed, active tab in `?tab=`, only the active tab constructed. |

Selection is addressable: `useEntitySelection` keeps the previewed record in
`?sel=<id>`, so a peek is linkable and survives refresh and back/forward.

### Which entities get a workspace

| Entity | Board | Workspace |
|---|---|---|
| Location / bin | Layout workspace preview | `/warehouse-app/layout/location/:id` — overview, configuration, label |
| Packaging type | Catalogue preview (geometry, lifecycle, archive) | `/warehouse-app/packaging/:id` — specification, carriers, availability, activity. Creation is `/packaging/new`. |
| Trailer visit | Gate / yard / register preview (position, load, blockers, gate clear, no-show) | `/warehouse-app/yard/visit/:id` — state machine, departure gate, movement ledger, custody chain |
| Handling unit (LPN) | New preview pane on the plates board | Existing plate cockpit `/warehouse-app/plates/:id` |

Everything else — appointments, tasks, exceptions — stays preview-sufficient:
they are transient work items, not master records with a lifecycle.

## Consequences

- Operational speed is preserved: boards keep their list, their filters and
  their scan intents; the preview is the fast path and one click reaches depth.
- URLs, RPCs, hooks and permissions are unchanged. This is a UI composition
  change; no business behaviour moves.
- `LocationInspector.tsx` is deleted. `TrailerVisitDrawer` is now a preview;
  its former body lives in `TrailerVisitBody.tsx` and is rendered by the visit
  workspace.
- Guarded by `src/test/architecture/warehouse-preview-vs-workspace.test.ts`:
  no form inputs, tab systems or dialogs inside `*Preview.tsx`, and every
  preview must offer a `workspaceHref`.

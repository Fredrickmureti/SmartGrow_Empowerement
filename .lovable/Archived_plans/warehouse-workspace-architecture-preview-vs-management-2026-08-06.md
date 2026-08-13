# Warehouse workspace architecture — preview vs management

## Verdict from the audit

Mature WMS products (SAP EWM, Oracle WMS, Manhattan, Blue Yonder, D365 SCM, Odoo) all
split entity interaction into exactly three tiers:

1. **Work board** — the list/map/tree an operator lives in.
2. **Preview** — "what is this, is it healthy, what can I do right now" (seconds).
3. **Object workspace** — a routable, full-width page owning everything about one
   entity: master data, configuration, history, telemetry, audit.

This ERP already codified that same standard in `docs/design-system/records.md`
(object page = `RecordShell` on a route, peek = `DetailSheet`, dialog = confirm only),
and Sales, Purchases, Inventory, Products and Employees follow it.

**The Warehouse app has drifted away from it.** Confirmed in code:

- `LocationInspector` (293 lines, inside the layout split pane) is simultaneously a
  summary, a *master-data editor* (name, barcode), a *configuration editor*
  (pick sequence, putaway priority, capacity, putaway-target and staging flags),
  a lifecycle control (block/retire) and a label surface. A bin has **no route** —
  it can only be reached by clicking in a pane, so it cannot be linked, bookmarked,
  or opened from a task, exception or scan.
- `PackagingDetailPanels` (306 lines) edits carrier rules, surcharges, availability
  and stock levels inside a right pane.
- `TrailerRegister` mixes an inline create form, an edit form and a history sheet
  in one 275-line page; the trailer has no object page while `TrailerVisitDrawer`
  (520 lines, tabbed) has become an application inside a drawer.
- `WarehousesList`/`WarehouseView` *do* follow the standard — proof the pattern
  works and the rest is drift, not a different requirement.

The panels cannot absorb what is coming (telemetry, heat maps, IoT/ASRS state,
capacity optimisation, audit) at 420px wide. So: keep master-detail, shrink the
panel back to preview, and give the entities that deserve one a real workspace.

## Which entities get what

| Entity | Preview (peek) | Object workspace (route) |
|---|---|---|
| Warehouse | yes (exists) | yes — exists, keep |
| Location / zone / aisle / rack / shelf / **bin** | yes | **yes — new** `/warehouse-app/layout/location/:id` |
| License plate (handling unit) | yes — new | yes — exists (`plates/:id`) |
| Trailer | yes | **yes — new** `/warehouse-app/yard/trailers/:id` |
| Packaging spec | yes | **yes — new** `/warehouse-app/packaging/:id` |
| Dock, zone-as-group, inspection, yard visit | preview only | no — they are documents/slots, served by existing sheets |

Rule: an entity earns a workspace when it owns configuration, history and
telemetry that will keep growing. Otherwise it stays a preview.

## What gets built

### 1. A shared warehouse entity pattern (no new one-off layouts)
- `src/features/warehouse/entity/EntityPreview.tsx` — header (identity + status),
  KPI strip, "open work" list, ≤4 primary actions, and a single
  **"Open workspace →"** link. Read-only by contract; no field inputs.
- `src/features/warehouse/entity/EntityWorkspaceShell.tsx` — thin wrapper over the
  existing `RecordShell` + `RecordHeader` + `Section`, with a lazy tab set.
- `src/features/warehouse/entity/useEntitySelection.ts` — selection lives in the URL
  (`?sel=<id>`), so previews are shareable and back/forward work.

### 2. Location workspace (the worst offender first)
- `LocationInspector` is rewritten as a preview: identity, path, occupancy bar,
  state, stock summary, open tasks, quick acts (print label, block/unblock, move,
  add inside), plus "Open workspace".
- New `src/pages/warehouse/LocationWorkspace.tsx` at `layout/location/:id`, tabs:
  Overview · Configuration (pick sequence, putaway priority, capacity, flags,
  barcode/name — moved out of the pane) · Stock · Activity · Label.
  Tabs are lazy; each is its own file under `features/warehouse/locations/workspace/`.

### 3. Packaging, Trailer, Handling unit
- `PackagingDetailPanels` splits: summary stays in the pane; carrier rules,
  surcharges, availability and stock editing move into
  `/warehouse-app/packaging/:id` tabs.
- `TrailerRegister` keeps list + preview; create/edit forms move to a
  `/warehouse-app/yard/trailers/:id` workspace (and `/new`), history becomes a tab.
- `LicensePlates` gains a peek preview that links to the existing `plates/:id`
  page instead of jumping straight to a full route.

### 4. Guardrails so it cannot drift again
- ADR `docs/adr/0122-warehouse-entity-workspaces.md` — preview vs workspace contract.
- `src/test/architecture/warehouse-preview-vs-workspace.test.ts`:
  no `<Input`/`<Switch`/`<Textarea`/`.mutate(` inside `*Inspector.tsx`,
  `*Preview.tsx` or `*DetailPanels.tsx`; every workspace entity in the table above
  must have a route; preview files capped in size.
- Memory rule added to `mem/features/warehouse-nav-ia.md`.

## Preserved

Every existing URL, query hook, RPC and mutation keeps working. No schema changes,
no business-logic changes. Split panes stay — operators still select-and-see in one
click; only the *editing and analysis* leaves the pane.

## Sequencing

1. Shared entity pattern + URL selection.
2. Location preview/workspace split (largest win).
3. Packaging + Trailer + handling-unit preview.
4. ADR, architecture test, memory, full test run.

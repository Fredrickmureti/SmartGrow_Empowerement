# Warehouse Information Architecture Refactor

## Step 0 — unblock the build (must happen first)

Three warehouse pages currently fail to compile with stray duplicated JSX
closers left by an earlier edit. Confirmed by reading the files:

- `src/pages/warehouse/CountReview.tsx:198` — `</Section> )}` followed by a
  second orphan `)}` on line 199.
- `src/pages/warehouse/LoadingBay.tsx:359`, `:371`, `:421` — same
  `</Section> )}` + orphan `)}` pattern, three times.
- `src/pages/warehouse/LoadingManifestPlanner.tsx:202` — `</Section> </PageBody>`
  followed by a duplicate `</PageBody>` on line 203.

Fix: delete the duplicated closing token in each case. No behaviour change.

## What's wrong today


`src/apps/warehouse/nav.ts` exposes **29 links in 2 groups** — 24 of them in a single
flat "Operations" list, plus a "Master" bucket. Verified from the file:

- Execution work (Receiving, Putaway, Dispatch, Cycle counts) sits beside
  configuration (Putaway strategies, Packaging catalogue, Warehouse layout).
- Business events are scattered: Receiving, Returns, QC, Cross-dock and the
  Inbound tower are five separate top-level entries that describe one inbound flow.
- Yard is split across four top-level rows (Yard control tower, Gate console,
  Yard marshal, Trailer register).
- Terminology mixes operator language with implementation language
  ("Execution telemetry", "License plates", "Yard control tower").
- Nothing about the structure absorbs the next 15 planned capabilities
  (waves templates, carriers, robotics, labour standards) without another rewrite.

The sidebar component already supports nested, collapsible `children`
(`WorkspaceSidebar.tsx`) and the HR Employees app already uses that pattern, so
this refactor uses existing platform capability — no new nav primitives.

## Architectural principles applied

Drawn from how SAP EWM, Manhattan, Blue Yonder and Oracle WMS organise work:

1. **Process domains, not pages.** Top level mirrors the physical goods flow:
   inbound → storage/inventory control → outbound → yard → quality → analysis.
2. **Execution is separated from configuration.** Everything an operator touches
   during a shift lives in process domains; everything an administrator sets up
   once lives in a single Configuration domain at the bottom.
3. **Control towers stay one click away.** High-frequency, high-visibility
   surfaces (Overview, Operator tasks, Exceptions) are pinned at the top level,
   unnested, to protect operational speed.
4. **Every domain is an extension point.** New capabilities plug in as children
   of an existing domain instead of adding a top-level row.

## Proposed structure

```text
WORK                      (flat, high frequency — never nested)
  Overview
  My tasks
  Exceptions

INBOUND
  Inbound control tower
  Appointments (was Dock schedule)
  Receiving
  Quality inspections (was Quality control)
  Putaway
  Cross-dock
  Returns

INVENTORY CONTROL
  Replenishment
  Cycle counts
  Slotting
  Handling units (was License plates)

OUTBOUND
  Outbound control tower
  Wave planning (was Wave planner)
  Dispatch & loading (was Dispatch)

YARD
  Yard overview (was Yard control tower)
  Gate
  Yard marshal
  Trailers (was Trailer register)

WORKFORCE
  Labour

ANALYSIS
  Operations performance (was Execution telemetry)
  3PL billing

CONFIGURATION
  Warehouses
  Layout & storage (was Warehouse layout)
  Putaway strategies
  Packaging catalogue
```

29 links preserved — nothing removed, nothing orphaned. Top-level rows drop from
29 to 8 groups + 3 pinned links; the deepest click path is 2.

Renames are limited to cases where enterprise terminology is clearly better
("License plates" → "Handling units", "Execution telemetry" → "Operations
performance", "Dock schedule" → "Appointments"). URLs are **not** changed, so
bookmarks, deep links and tests keep working.

## Technical scope

- Rewrite `src/apps/warehouse/nav.ts` as the single declarative source of truth:
  domain groups, each item a `WorkspaceNavItem`, sub-items via `children`.
  No conditional logic, no per-page nav constants.
- No route file changes: `src/apps/warehouse/routes.tsx` and every `to:` path
  stay identical. `WarehouseLayout` keeps mounting `WAREHOUSE_APP` +
  `WAREHOUSE_NAV`, so ADR 0101 nav/app coherence still holds.
- Add `src/test/architecture/warehouse-nav-ia.test.ts` asserting:
  - every route path declared in `routes.tsx` (excluding detail/`:param` and
    redirect routes) is reachable from `WAREHOUSE_NAV` — no orphan pages;
  - every nav `to:` resolves to a declared route — no dead links;
  - nav depth never exceeds 2 and no group exceeds ~8 items — the flat-sidebar
    regression cannot silently return.
- Add `docs/adr/` entry recording the warehouse domain boundaries and the rule
  that new warehouse surfaces attach as children of an existing domain.
- Save the domain map to project memory so future warehouse work follows it.

## Out of scope

No route renames, no page/component changes, no data or business-logic changes.
Purely navigation structure, labels and the guardrails that keep it intact.

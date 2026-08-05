# ADR 0121 — Warehouse information architecture: domain-oriented navigation

Status: Accepted
Date: 2026-08-05
Supersedes: the flat `Operations` / `Master` grouping in `src/apps/warehouse/nav.ts`
Related: ADR 0079 (Inventory ↔ Warehouse split), ADR 0101 (nav replacement only across app boundaries)

## Context

`WAREHOUSE_NAV` had grown to 29 links in two groups — 24 of them in a single
flat `Operations` list. Nothing in the codebase stopped a new warehouse page
from appending one more top-level row, so every shipped phase (yard, labour,
cross-dock, billing, telemetry, exceptions, returns) widened the sidebar.

Concrete symptoms:

- execution work sat beside configuration (Receiving next to Putaway strategies);
- one business event was scattered across several top-level rows (Receiving,
  Returns, QC, Cross-dock, Inbound tower are all the inbound flow);
- Yard occupied four sibling rows with no parent concept;
- labels mixed operator language with implementation language
  ("Execution telemetry", "License plates");
- the structure could not absorb the planned roadmap (wave templates, carriers,
  dock templates, labour standards, robotics, ASRS, voice picking) without yet
  another redesign.

## Decision

The Warehouse sidebar is organised by **goods-flow domain**, not by page.

```text
Work              Overview · My tasks · Exceptions
Inbound           Inbound control tower · Appointments · Receiving ·
                  Quality inspections · Putaway · Cross-dock · Returns
Inventory control Replenishment · Cycle counts · Slotting · Handling units
Outbound          Outbound control tower · Wave planning · Dispatch & loading
Yard              Yard overview · Gate · Yard marshal · Trailers
Workforce         Labour
Analysis          Operations performance · 3PL billing
Configuration     Warehouses · Layout & storage · Putaway strategies ·
                  Packaging catalogue
```

Rules that follow from this decision:

1. **Domains are the top level.** A new top-level group means a new domain
   boundary and requires an ADR. Everything else attaches inside a domain.
2. **Execution never mixes with configuration.** Administrator surfaces live in
   `Configuration`, which is always the last group so it cannot compete visually
   with shift-time work.
3. **`Work` stays flat and short.** It is the operator landing zone; the three
   highest-frequency surfaces must never be nested behind a disclosure.
4. **Depth is capped at 2, group size at 8.** Beyond that, the surface becomes a
   `WorkspaceNavItem.children` entry of an existing item.
5. **No orphan routes.** Every routable warehouse surface is reachable from the
   nav, except entries in the documented exemption list (currently only the
   handheld `mobile/next` deep link).
6. **URLs are frozen.** This is a labelling and grouping change only; no route
   moved, so bookmarks, deep links, redirects and e2e specs are unaffected.

Renames applied only where enterprise terminology is clearly better:
License plates → Handling units, Execution telemetry → Operations performance,
Dock schedule → Appointments, Wave planner → Wave planning, Dispatch →
Dispatch & loading, Yard control tower → Yard overview, Trailer register →
Trailers, Warehouse layout → Layout & storage, Quality control → Quality
inspections, Operator tasks → My tasks.

## Enforcement

`src/test/architecture/warehouse-nav-ia.test.ts` fails the build on: orphan
routes, dead nav links, depth > 2, any group over 8 items, duplicate targets,
targets outside `/warehouse-app/`, and `Configuration` not being last.

ADR 0101 still holds: `WAREHOUSE_APP` is mounted with exactly one nav
(`WAREHOUSE_NAV`) from `WarehouseLayout`. Sub-surfaces expand via `children`;
the sidebar is never swapped.

## Consequences

- Top-level rows drop from 29 to 8 groups plus 3 pinned links; the longest
  click path is 2.
- Future capabilities have an obvious home: picking strategies and wave
  templates under Outbound, dock/inspection templates under Configuration,
  labour standards and resource scheduling under Workforce, automation and
  robotics as an Automation domain (new ADR) once they exist.
- Warehouse pages that hard-code a legacy label in their own header should be
  updated as they are touched; the nav is the source of truth for terminology.

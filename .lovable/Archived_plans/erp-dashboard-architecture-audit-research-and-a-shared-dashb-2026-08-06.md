# ERP Dashboard Architecture — audit, research, and a shared dashboard system

No JSX is touched until sections 1–5 are agreed. The Warehouse Overview is the
first *implementation* of the system, not the subject of the work.

## 1. Audit of the current Warehouse Overview

Verified by reading `src/pages/warehouse/WarehouseOverview.tsx` (248 lines),
`src/features/warehouse/{overview,control-center}`, `src/design-system/*`.

What is genuinely right today and must be preserved:

- Aggregation lives in SQL; the page composes and never computes (ADR 0102).
- Data access is per-domain typed hooks; realtime invalidation, no polling.
- Panels are already extracted components (`HealthBanner`, `FlowSpine`,
  `PriorityStack`, `CapacityPanel`, `EquipmentPanel`, `ActivityFeed`, …).

The architectural defects — all layout/composition, none cosmetic:

1. **No dashboard layer exists.** The design system stops at page primitives
   (`PageHeader`, `PageBody`, `Section`). Everything above "a titled card" is
   hand-authored per page. `WarehouseOverview` is ~90 lines of bespoke
   `div.grid.grid-cols-1.gap-6.@4xl/page:grid-cols-3` scaffolding.
2. **Layout is hardcoded into the page.** Column spans, breakpoints and
   ordering are literals inside JSX, so a new widget means editing the grid,
   and every module reinvents the same grid (`Dashboard.tsx`,
   `InboundDashboard.tsx`, `OutboundDashboard.tsx` each carry their own).
3. **Everything is a `Section`.** A KPI, a live table, a feed and a health
   banner all render with identical chrome and weight, so visual hierarchy
   does not encode importance. There is one card type where the domain needs
   five.
4. **Executive and operational content are mixed at equal weight.** "Act now",
   flow, live work, capacity, labour, exceptions and activity all read as
   peers; nothing is progressively disclosed or demoted.
5. **No KPI primitive.** There is no metric/delta/sparkline/threshold
   component anywhere in the ERP, despite `recharts` already being installed.
6. **Fixed two-thirds/one-third split.** The rail/main split is a layout
   decision baked into the page; it cannot adapt to widget count, density mode
   or module.
7. **Per-widget loading/error is inconsistent.** The page gates the *whole*
   body on `health.isLoading`; individual panels each handle failure their own
   way. One slow RPC blanks the command centre.
8. **No density, no responsive contract, no a11y contract** for dashboards.
   `data-density="compact"` exists in tokens but no dashboard honours it.

Verdict: the composition layer is wrong, the data layer is right. Fix the
former; leave the latter untouched.

## 2. Research findings — enterprise operational dashboards

Patterns that recur across SAP Fiori (EWM / S4), Manhattan Active, Blue Yonder,
Oracle Fusion SCM, D365 SCM, Grafana, Datadog, Stripe, Linear and Azure Portal:

- **Fixed reading spine, not a free canvas.** Fiori Overview Pages, Manhattan
  and Oracle all use an ordered, curated set of "cards" with declared sizes;
  drag-and-drop dashboards are an *analytics* pattern (Grafana/Datadog), not an
  operational one. Operators need muscle memory of position.
- **Answer-first hierarchy.** Row 1 = one status verdict + a KPI ribbon;
  row 2 = ranked actions; row 3+ = supporting detail. Stripe and Azure both
  lead with a single scalar band before any chart.
- **Card taxonomy, not one card.** Fiori Overview Page formally types cards
  (List, Table, Analytical, Stack, Link-List, KPI). Datadog types widgets
  (query value, timeseries, top-list, event stream). The type carries the size
  and the loading/empty/error behaviour.
- **Unit-based responsive grid.** 12-column at desktop, collapsing to 6/4/1;
  widgets declare span in units (`sm/md/lg/xl`), never pixels. Grafana and
  Fiori both do this; container queries are the modern equivalent.
- **Density is a first-class setting** (Fiori cozy/compact, Linear's tight
  scale). Operational dashboards default to denser than marketing UI.
- **Progressive disclosure.** Each card shows the headline and links into the
  owning module ("navigation card"). No card duplicates a full module view.
- **Per-widget lifecycle.** Every card independently renders skeleton → data →
  empty → error → retry. A dashboard never blanks wholesale.
- **Executive vs operational split.** Executive = trend/period-over-period,
  few numbers, large. Operational = now-state, queues, ageing, SLA countdowns,
  inline actions. The same page must not blend them at equal weight; ours
  currently does.

## 3. Adopt an existing foundation, or build?

Evaluated against this stack (React 19, TanStack Start/Router, Tailwind,
shadcn/ui, our own `@/design-system` + `PlatformShell` + `--ds-*` tokens):

| Option | Verdict |
| --- | --- |
| `react-grid-layout` / `dnd-kit` dashboards | Solves user-draggable canvases — a problem we do not have. Adds pixel-height thinking and a11y cost. Reject as the default; keep as a later opt-in for analytics-only boards. |
| Tremor | Closest fit (Tailwind + React, good chart/KPI set). But it ships its own colour/typography/spacing scale that would fork our `--ds-*` tokens and shadcn theme, and it owns chart internals we would fight. Reject as a foundation; usable as inspiration. |
| shadcn `chart` block + `recharts` | Already in the stack (`recharts@2.15`). Take *this* for visualisation only. |
| Admin templates (Tailwind UI, Refine, Material/Ant dashboards) | Whole-app shells that would conflict with `PlatformShell` and the registry-driven nav we already consolidated. Reject. |
| MUI X / AG Grid dashboards | Second design system + licensing (AG Grid enterprise). Reject; `@tanstack/react-table` already covers grids. |

**Recommendation: build a thin dashboard layer inside our own design system,
and adopt libraries only for what they uniquely provide.** Evidence: we already
own the shell, tokens, nav registry and enforced import rules; every third-party
foundation duplicates one of those and forks the token layer. The missing piece
is small (a grid + a card taxonomy + a KPI primitive ≈ 8 components), while the
cost of a competing design language is permanent. Zero new dependencies:
`recharts`, `@tanstack/react-table`, `framer-motion` and container queries are
already present.

## 4. Dashboard architecture proposal

New folder `src/design-system/dashboard/`, exported from `@/design-system`.

```text
DashboardCanvas          declares density + column model, provides context
 └─ DashboardBand         a labelled horizontal band (Status / Act now / Flow …)
     └─ DashboardWidget   the ONLY card in a dashboard; typed + span-aware
         └─ widget body   module-owned content (existing panels, unchanged)
```

Rules:

- Pages declare **composition**, never geometry. A page lists bands and
  widgets with a semantic `span` (`quarter | third | half | two-thirds | full`)
  and a `priority`; the canvas resolves spans to container-query columns.
- `DashboardWidget` owns the full lifecycle: `status="loading|empty|error|ready"`
  wired to a React Query result, with skeleton, `EmptyState`, `ErrorState` and
  retry built in. No page-level blanking.
- Widget `variant` encodes weight, not styling choices: `kpi`, `status`,
  `action`, `flow`, `list`, `feed`, `chart`, `plain`.
- Every widget may declare a `drillTo` route → rendered consistently as the
  card's "open module" affordance (progressive disclosure by construction).
- Zero hardcoded dimensions: heights come from content plus a `minRows` hint;
  spacing/type/radius come exclusively from `--ds-*`.

## 5. Reusable dashboard primitives (the design language)

| Primitive | Purpose |
| --- | --- |
| `DashboardCanvas` | Root; density (`comfortable`/`compact`), 12→6→4→1 container-query grid. |
| `DashboardBand` | Ordered semantic row with optional title/actions; controls reading spine. |
| `DashboardWidget` | Universal card: title, meta, drill link, variant, span, lifecycle. |
| `KpiRibbon` + `KpiTile` | Scalar band: value, unit, delta, trend direction, threshold tone, optional sparkline (recharts). |
| `HeroStatus` | Single-verdict banner: state, reason, worst contributor, primary action. |
| `PriorityPanel` | Ranked "do this first" list: severity tone, impact, one action each. |
| `FlowStrip` | Stage → stage pipeline with backlog/age/SLA and selection. |
| `LiveWorkPanel` (shell) | Dense `@tanstack/react-table` grid with inline actions + virtualisation. |
| `MetricCard` | Compact single metric for grid infill. |
| `GaugeCard` | Utilisation/capacity with threshold bands. |
| `HealthList` | Multi-entity status roll-up (equipment, integrations, zones). |
| `ExceptionSummary` | Typed exception counts with triage links. |
| `TimelineFeed` | Reverse-chronological event stream with relative time. |
| `DrillLink` | Consistent "open the owning module" affordance. |

All are module-agnostic: Finance uses `KpiRibbon` + `GaugeCard` + `TimelineFeed`
for cash position exactly as Warehouse uses them for capacity.

## 6. Warehouse Overview redesign, expressed in the system

```text
Band: Status        HeroStatus (full)  +  KpiRibbon: open work, at-risk SLA,
                    inbound due, outbound due, exceptions, on-shift labour
Band: Act now       PriorityPanel (two-thirds)  |  ExceptionSummary (third)
Band: Flow          FlowStrip (full)  →  LiveWorkPanel (full, stage-filtered)
Band: Towers        Inbound (half) | Outbound (half)   [navigation cards]
Band: Readiness     GaugeCard capacity | HealthList labour |
                    HealthList equipment | HealthList zones   (quarters)
Band: Activity      TimelineFeed (full, collapsed by default)
```

Existing panels are reused verbatim as widget bodies; only the scaffolding
around them changes. No data hook, RPC or query key is modified.

## 7. Implementation roadmap

1. **Primitives** — `src/design-system/dashboard/*` + tokens
   (`--ds-dashboard-gap`, span map, density overrides), exported from
   `@/design-system`. Unit tests for span→column resolution and lifecycle.
2. **KPI + chart layer** — `KpiRibbon`, `MetricCard`, `GaugeCard`, sparkline
   wrapper over the existing `recharts` install.
3. **Docs + guardrails** — extend `docs/design-system.md` with a "Dashboards"
   chapter; add an architecture test asserting dashboards compose
   `DashboardCanvas` and contain no raw `grid-cols-*` scaffolding.
4. **Warehouse Overview migration** — recompose section 6; delete the bespoke
   grid; behaviour-parity check against today's page.
5. **Second module proof** — migrate `InboundDashboard` (or the global
   `Dashboard.tsx`) to prove reuse; only then declare the language stable.
6. **ADR 0103** — "Dashboard composition is a design-system concern",
   superseding the per-page grid convention.

Modules beyond step 5 migrate opportunistically; no big-bang rewrite.

## 8. Risks

- **Over-abstraction.** Mitigation: primitives ship only with props the
  Warehouse + one second module actually need; `variant="plain"` is the escape
  hatch, not a new component.
- **Regression on a live command centre.** Mitigation: bodies are reused
  unchanged; migration is pure composition; parity checked panel by panel.
- **Container-query support/nesting.** Already used (`@4xl/page`) in this
  codebase, so the pattern is proven here.
- **Third design language creeping in** if someone later adds Tremor.
  Mitigation: ADR + lint rule.
- **Scope creep into data/business logic.** Explicitly out of scope: no RPC,
  hook, query-key or SQL change in any step.

## 9. Verification checklist

- Responsive: 360 / 768 / 1024 / 1440 / 1920 — no horizontal scroll, no
  clipped headings, KPI ribbon reflows 6→3→2, bands keep reading order.
- Accessibility: each band is a landmark with an accessible name; widgets are
  `section` + heading, keyboard-reachable drill links, visible focus, live
  regions announce refresh, contrast AA on all status tones.
- Density: `data-density="compact"` visibly tightens dashboards.
- Lifecycle: force each widget's query to loading / empty / error — the rest of
  the page stays interactive; retry works per widget.
- Maintainability: adding a widget is one array entry, no grid edit; no
  `grid-cols-*`, no fixed px heights, no hardcoded colours in dashboard pages.
- Consistency: second migrated module renders with identical rhythm, chrome and
  typography with no module-local overrides.
- Parity: every number and action on the Warehouse Overview before the change
  is present after it.

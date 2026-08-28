# Warehouse ↔ Finance card consistency — audit findings and remediation plan

## What the audit found (verified in code, not assumed)

**Finance AR/AP is already component-canonical.** `src/pages/finance/AccountsReceivable.tsx`
and `AccountsPayable.tsx` do not hand-roll stat blocks. They render
`SummaryStatCard` / `SummaryStatGrid` from
`src/components/common/SummaryStatCards.tsx`, whose own header comment
declares it "the ONE stat card for ledger-style summary strips". That
primitive defines: uppercase 12px muted label with optional leading icon,
`stat-value` numeric typography with `tabular-nums`, optional caption
footer, an optional coloured left accent rule (used for aging buckets), a
tone scale (primary/emerald/amber/orange/blue/purple/destructive), and a
click affordance (`cursor-pointer` + `hover:shadow-md`). The grid is
`auto-fit, minmax(220px, 1fr)` — it wraps rather than squashing values.

45 files across Finance, Sales, Purchases, Inventory and Reports already
use it. **Zero Warehouse files use it.**

**Warehouse has forked the stat card at least four ways:**

| Fork | Location | Divergence from canonical |
| --- | --- | --- |
| `MetricTile` | `features/warehouse/dashboards/DashboardPrimitives.tsx` | own `Tone` scale (ok/warn/bad/neutral), lowercase label, `text-2xl`, no accent rule, hover = border tint not shadow, navigation via wrapping `<Link>` |
| `Kpi` (private) | `features/warehouse/yard/YardKpiStrip.tsx` | inline `tone` as a raw class string, no drill-down at all |
| `Kpi`-alikes | `replenishment/ReplenKpiStrip.tsx`, `wave-tower/WaveCapacityPanel.tsx`, `wave-tower/WaveStageStrip.tsx`, `exceptions/ExceptionAnalytics.tsx`, `control-center/FlowSpine.tsx`, `overview/TowerSummaryCard.tsx`, `labour/*Panel.tsx` | each re-authors header/value/hint markup |
| Fully inline `<Card><CardContent className="p-4">` stat blocks | ~19 page/feature files incl. `WarehousesList`, `LabourBoard`, `CrossdockBoard`, `DockSchedule`, `ExceptionsInbox`, `Slotting`, `LicensePlates`, `ExecutionTelemetry`, `BillingBoard`, `CycleCounts`, `Replenishment`, `YardControlTower` | no shared contract at all |

**What Warehouse already does right — and better.** 101 Warehouse files
import from `@/design-system`, so shell, `PageHeader`, `Section`,
`EmptyState`/`LoadingState`/`ErrorState` and the record/preview split
(ADR 0122) are already shared. Warehouse strips also use **container
queries** (`@xl/page`, `@4xl/page`, `@5xl/page`) rather than viewport
breakpoints, which is the more correct responsive model — a strip inside a
narrow column reflows correctly. Finance's `SummaryStatGrid` uses
`auto-fit/minmax` which is close in spirit but is width-driven only.

**Conclusion on canon.** Finance's *component* is canonical; Warehouse's
*responsive strategy* is the better half. The fix is not to copy Finance
into Warehouse — it is to make one card system that carries both, then
delete every Warehouse fork.

## What will be built

### Step 1 — harden the canonical card (shared, not Warehouse-specific)

In `src/components/common/SummaryStatCards.tsx`, additively:

- Make `SummaryStatGrid` container-query aware (`@container` on the grid
  wrapper, `auto-fit/minmax` retained as fallback) so it behaves the same
  in a full-width AR page and in a narrow Warehouse column. No visual
  change at current Finance breakpoints.
- Add `to?: string` for drill-down. Renders the card as a router link with
  the same hover treatment as `onClick`, replacing Warehouse's
  `<Link>`-wrapping pattern (which currently breaks card focus/keyboard
  semantics).
- Add operational tones by mapping Warehouse's `ok | warn | bad` onto the
  existing `emerald | amber | destructive` values — no new tone scale.
- Add `trend?` (delta + direction) and `status?` (badge slot) as optional
  slots so operational cards keep SLA/exception context without a fork.
- Add `loading?` rendering a skeleton in the card's own shape, so strips
  stop swapping between a spinner and a card and jumping the layout.

Re-export it from `@/design-system` so it stops being reachable only via a
`components/common` path, and keep the `components/common` export as an
alias so the 45 existing Finance/Sales/Purchases call sites are untouched.

### Step 2 — retire the Warehouse forks

`MetricTile` becomes a thin deprecated wrapper over `SummaryStatCard`
(preserving its prop names) so the ~2 dashboards using it keep working
during migration; `YardKpiStrip`'s private `Kpi`, `ReplenKpiStrip`,
`WaveStageStrip`, `WaveCapacityPanel`, `ExceptionAnalytics`,
`FlowSpine`, `TowerSummaryCard` and the labour panels are rewritten to
compose the canonical card. The wrapper is deleted at the end of the last
wave — no permanent parallel system.

### Step 3 — migrate page by page, in nav order

Each page: replace its stat blocks with the canonical card, give every
metric that represents work a drill-down target (metric → filtered list →
record), wire the card's own loading/empty state, and verify at 1440 /
1280 / 1024 / 768 / 390 px.

- **Wave A — Work**: Overview, My tasks, Exceptions
- **Wave B — Inbound**: Inbound control tower, Appointments, Receiving,
  Quality inspections, Putaway, Cross-dock, Returns
- **Wave C — Inventory control**: Replenishment, Cycle counts, Slotting,
  Handling units
- **Wave D — Outbound**: Outbound control tower, Wave planning,
  Dispatch & loading
- **Wave E — Yard**: Yard overview, Gate, Yard marshal, Trailers
- **Wave F — Workforce + Analysis**: Labour, Operations performance,
  3PL billing
- **Wave G — Configuration**: Warehouses, Layout & storage, Putaway
  strategies, Packaging catalogue

Domain semantics are preserved throughout: Warehouse cards keep saying
"Pending putaway", "Overdue dwell", "Wave shortfall" — only the
component and interaction contract are shared.

### Step 4 — lock it in

An architecture test (sibling to
`src/test/architecture/warehouse-nav-ia.test.ts`) that fails when a file
under `pages/warehouse` or `features/warehouse` authors its own stat
markup — inline `<Card>` with a large numeric value, or a local `Kpi`/
`Tile` component — instead of importing the canonical card. Plus a
Playwright pass over each wave's pages at the four widths, checking for
horizontal overflow and truncated values.

## Technical notes

- No business-logic or data changes. Derivation functions
  (`deriveYardKpis`, `useDomainOperations`, replenishment/wave models)
  are untouched; only their presentation layer changes.
- No new Warehouse-prefixed card component is created. If a Warehouse
  need cannot be expressed by the canonical card, the canonical card is
  extended (Step 1) and Finance inherits the capability.
- Existing Finance/Sales/Purchases/Inventory call sites are additive-only
  and must render byte-identically after Step 1 — verified by rendering
  AR/AP before and after.

## Sequencing

Step 1 → Step 2 → Waves A–G in order → Step 4. Each wave is brought to a
finished state (migrated, drill-downs wired, responsive-verified) before
the next begins.


======================IMPLEMENTATION PROGRESS==================
I'll inspect the actual Finance AR/AP implementation and the Warehouse pages before proposing anything.

I paused mid-way through the Warehouse card consolidation. Here's where things stand.

Done and typechecking clean:
- Canonical stat card hardened (`src/components/common/SummaryStatCards.tsx`): container-query-driven `SummaryStatGrid`, `to` drill-down as a proper router link, operational tone aliases (`ok`/`warn`/`bad`/`neutral` mapped onto the existing scale — not a second scale), optional `trend` and `status` slots, and in-shape skeleton `loading`. Re-exported from `@/design-system`.
- New shared composite/exception card (`CalloutCard`), extracted from the Finance reference `ControlAccountReconciliationCard`, which now renders it — so Finance and Warehouse exception surfaces are the same component, not look-alikes.
- Warehouse forks retired: `MetricTile` is now a deprecated wrapper over the canonical card; `YardKpiStrip`, `ReplenKpiStrip`, `WaveStageStrip`, `WaveCapacityPanel`, `ExceptionAnalytics`, `LabourPlanningPanel`, `LabourPerformancePanel` and the Exceptions Inbox strip all compose `SummaryStatCard`/`SummaryStatGrid`, with drill-down targets and tone-driven accents wired.

Remaining (waves B–G page migrations): `DockSchedule`, `Slotting`, `CrossdockBoard`, `ReturnsLaneBoard`, `CountReview`, `LicensePlates`, `LicensePlateView`, `LocationOverviewTab`, `LabourBoard`, `ExecutionTelemetry`, `BillingBoard`, `WarehousesList`, `WarehouseLayoutWorkspace`, `LabelVerifyDialog`, plus the Inbound/Outbound tower pages — each still authors its own `<Card>` stat markup. Also outstanding: the architecture test that fails bespoke warehouse stat markup, and the responsive Playwright pass at 1440/1280/1024/768/390. `FlowSpine` and `TowerSummaryCard` were assessed as legitimately distinct composite patterns rather than stat-card forks, though `TowerSummaryCard`'s inner mini-metrics should still adopt the `CalloutCard` metric treatment.


MAKE SURE NOT EVEN A SINGLE HAND HARRD ROLLED COMPONENT is used in warehouse and that every card, every icon including the UI is the evry same used in Finance
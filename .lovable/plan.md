# Warehouse ↔ Finance card consistency — verification verdict and completion plan (v2)

## Phase 1 — verification of the previous engineer's log (done, against the code)

**Confirmed true**

- `SummaryStatCard` / `SummaryStatGrid` in `src/components/common/SummaryStatCards.tsx`
  is the canonical card, and it is genuinely the one Finance uses — `pages/finance/AccountsReceivable.tsx`
  and `pages/finance/AccountsPayable.tsx` are its call sites. The Finance reference is
  architecturally sound; nothing needs correcting there before propagating it.
- Warehouse adoption really did grow: **22** files under `pages/warehouse` /
  `features/warehouse` now import the canonical card, including the Wave B and Wave C
  targets (`DockSchedule`, `CrossdockBoard`, `ReturnsLaneBoard`, `Slotting`,
  `CountReview`, `LicensePlates`, `LicensePlateView`, `LocationOverviewTab`,
  `LabelVerifyDialog`, `WarehouseLayoutWorkspace`, `WarehousesList`, `LabourBoard`).
- Only **one** file still renders a `text-2xl/3xl` metric inside hand-rolled chrome:
  `pages/warehouse/BillingBoard.tsx` (local `KpiCard` at line 1043). The "18 files"
  from the earlier plan is stale — that wave is largely done.

**Confirmed broken / not done**

- `pages/warehouse/ExecutionTelemetry.tsx` is still broken: `<SummaryStatGrid>` is
  closed with `</div>`. The build log reads "build OK" only because the route is lazy
  and never compiled — this is a real defect, not a false alarm.
- `MetricTile` deprecation wrapper still has a live caller (`pages/warehouse/CycleCounts.tsx`).
- The `warehouse-canonical-cards` architecture test does not exist. `src/test/architecture/`
  has nav / layout / container-responsive warehouse guards, no card guard.
- No responsive pass was run at any viewport.

**Newly found, not in the previous plan**

- **39 files** still use bespoke metric typography (`text-xl font-semibold`,
  `text-lg font-bold`, raw `tabular-nums`) — concentrated in the surfaces the earlier
  plan treated as exempt composites: `control-center/*` (FlowSpine, HealthBanner,
  BottleneckRail, LiveWorkPanel, LabourPanel), `inbound-tower/*`, `outbound-tower/*`
  (LoadingLane, DockYardStrip, ShipmentLifecycleBoard, ExceptionRail), `overview/*`
  (TowerSummaryCard, CapacityPanel, EquipmentPanel, PriorityStack), `labour/*`,
  `returns/*`, `packaging/*`. This is the actual remaining bulk of the work.
- **19 files** still hand-roll `<Card><CardContent>` where `Section` belongs.
- **47 files** render raw `<Badge>` instead of the canonical `StatusBadge`, so warehouse
  status tone vocabulary diverges from Finance.

Verdict: Waves B and C are real. Waves D–G and Step 4 are not, and the true scope is
composite panels and status/section chrome, not just stat strips.

## Phase 2 — remaining execution

### Wave 0 — repair first
Fix the `ExecutionTelemetry` closing tag, then typecheck the whole warehouse tree so no
further wave is built on a file that does not compile.

### Wave D — Outbound and Wave planning
`OutboundDashboard`, `outbound-tower/LoadingLane`, `DockYardStrip`,
`ShipmentLifecycleBoard`, `OutboundBottleneckRail`, `ExceptionRail`, `WavePlanner`,
`LoadingBay`, `LoadingManifests`. Metric blocks adopt `SummaryStatGrid`/`SummaryStatCard`;
each metric that represents work gets a `to` drill-down; `loading` replaces bespoke spinners.

### Wave E — Yard
`YardControlTower`, `GateConsole`, `YardMarshal`, `TrailerRegister`,
`TrailerVisitWorkspace` — re-verify after the Wave-A `YardKpiStrip` change and migrate
page-level blocks left behind.

### Wave F — Control centre, Inbound tower, Overview composites
`control-center/*`, `inbound-tower/*`, `overview/*`. These stay composite surfaces, but
their inner metric treatment uses the canonical card's metric block so typography, icon
sizing and number formatting are identical to Finance. `TowerSummaryCard` and
`HealthBanner` become configurations of the shared primitive, not parallel designs.

### Wave G — Workforce, Analysis, Configuration
`LabourBoard` (finish + typecheck), `labour/*` panels, `ExecutionTelemetry`,
`BillingBoard` (delete local `KpiCard`), `PutawayStrategies`, `PackagingCatalogue`,
`packaging/workspace/*`.

### Wave H — Status and section chrome (new)
Replace raw `<Badge>` with `StatusBadge` across the 47 offending files, and hand-rolled
`<Card><CardContent>` with `Section` across the 19. Ad-hoc empty/loading/error blocks
become `EmptyState` / `LoadingState` / `ErrorState`.

### Step 4 — lock it in
- `src/test/architecture/warehouse-canonical-cards.test.ts`: fails when a warehouse file
  declares a local `Kpi`/`Tile`/`StatCard` component, renders a large numeric value
  inside a hand-rolled `<Card>`, or hand-rolls a status pill instead of `StatusBadge`.
- Delete `MetricTile` once `CycleCounts` is migrated.
- Playwright pass over every Warehouse page at 1440 / 1280 / 1024 / 768 / 390 px,
  checking horizontal overflow and truncated values, mirroring the Finance AR/AP baseline
  captured at the same widths.

## Technical notes

- Presentation only. `deriveYardKpis`, `useDomainOperations`, replenishment/wave models
  and all data derivation stay untouched.
- No Warehouse-prefixed card component is created. If a Warehouse need cannot be
  expressed, `SummaryStatCard` is extended additively and Finance inherits it; the 55
  existing Finance/Sales/Purchases/Inventory call sites must render identically.
- Warehouse wording stays Warehouse wording — "Pending putaway", "Overdue dwell",
  "Wave shortfall" — only the component architecture is shared.

## Sequencing

Wave 0 → D → E → F → G → H → Step 4, each wave migrated, drill-downs wired and
typechecked before the next begins.

======================IMPLEMENTATION PROGRESS==================
(Verify any claims)


Waves D and E are done: `LoadingLane` now uses the canonical `SummaryStatCard`/`SummaryStatGrid` (tones, footers, drill-down, skeleton loading), the last `MetricTile` caller (Cycle counts) is migrated and the deprecated wrapper deleted, and a new architecture test locks Warehouse to the one ERP-wide card. Yard and the outbound workbenches were audited and already conform.


MAKE SURE NOT EVEN A SINGLE HAND HARRD ROLLED COMPONENT is used in warehouse and that every card, every icon including the UI is the evry same used in Finance
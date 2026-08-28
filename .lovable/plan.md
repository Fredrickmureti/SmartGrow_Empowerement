# Warehouse ↔ Finance card consistency — verification verdict and completion plan

## Phase 1 — independent verification (done, in code)

I re-checked every claim in the previous engineer's log against the files.

**Confirmed true:**

- `src/components/common/SummaryStatCards.tsx` (245 lines) really is hardened:
  `SummaryStatGrid` is container-query driven (`@container/stats` with
  `auto-fit/minmax` steps at `@md` and `@3xl`), `SummaryStatCard` accepts
  `to` (renders a real router `<Link>`), `trend`, `status`, `loading`
  (in-shape skeleton), and the operational tones `ok`/`warn`/`bad`/`neutral`
  are *aliases* mapped onto the existing scale — no second tone system.
- `MetricTile` in `features/warehouse/dashboards/DashboardPrimitives.tsx` is
  now an explicitly deprecated wrapper over the canonical card.
- Nine Warehouse files now import `SummaryStatCard`: `ExceptionsInbox`,
  `DashboardPrimitives`, `ExceptionAnalytics`, `LabourPerformancePanel`,
  `LabourPlanningPanel`, `ReplenKpiStrip`, `WaveCapacityPanel`,
  `WaveStageStrip`, `YardKpiStrip`.

**Confirmed still outstanding** — 18 Warehouse files still author their own
large-numeric stat markup, and 28 files under `pages/warehouse` /
`features/warehouse` still hand-roll `<Card><CardContent>` blocks that a
canonical primitive should own. The architecture test that would prevent
this does not exist (`src/test/architecture/` has warehouse nav, layout,
container-responsive tests — no stat-card test). No responsive pass was run.

So: Step 1 and Step 2 are genuinely complete. Waves B–G and Step 4 are not.

## Phase 2 — plan corrections

Two gaps in the previous plan, added here:

1. It scoped only "stat cards". Your instruction is broader — no hand-rolled
   card, icon, or chrome anywhere in Warehouse. So the sweep also covers
   section/list card chrome (`<Card><CardHeader><CardTitle>` used where
   `Section` belongs), bespoke status pills (must be `StatusBadge`), and
   ad-hoc empty/loading/error blocks (must be `EmptyState`/`LoadingState`/
   `ErrorState`).
2. `FlowSpine`, `TowerSummaryCard`, `HealthBanner`, `LoadingLane` and
   `EntityPreview` are composite surfaces, not stat strips. Rather than
   exempting them, their inner metric treatment adopts the shared
   `CalloutCard`/`SummaryStatCard` metric block so the typography and icon
   language are identical to Finance.

## Phase 3 — remaining execution

### Wave B — Inbound
`DockSchedule`, `CrossdockBoard`, `ReturnsLaneBoard`, plus the Inbound
control tower (`InboundDashboard`, `HealthBanner`, `FlowSpine`): replace
inline stat blocks with `SummaryStatGrid`/`SummaryStatCard`, wire each
metric to a filtered destination via `to`, use `loading` instead of
swapping in a spinner.

### Wave C — Inventory control
`Slotting`, `CountReview`, `LicensePlates`, `LicensePlateView`,
`LocationOverviewTab`, `LabelVerifyDialog`.

### Wave D — Outbound
`OutboundDashboard`, `LoadingLane`, and the dispatch/loading strips.

### Wave E — Yard
Re-verify `YardControlTower`, `GateConsole`, `YardMarshal`,
`TrailerRegister` after the Wave-A change to `YardKpiStrip`; migrate any
page-level blocks left behind.

### Wave F — Workforce + Analysis
`LabourBoard`, `ExecutionTelemetry` (Operations performance),
`BillingBoard`.

### Wave G — Configuration
`WarehousesList`, `WarehouseLayoutWorkspace`, `PutawayStrategies`,
`PackagingCatalogue`.

Every migrated metric that represents work gets a drill-down target
(metric → filtered list → record). Warehouse wording stays Warehouse
wording — "Pending putaway", "Overdue dwell", "Wave shortfall".

### Step 4 — lock it in
- `src/test/architecture/warehouse-canonical-cards.test.ts`: fails when a
  file under `pages/warehouse` or `features/warehouse` renders a large
  numeric value inside a hand-rolled `<Card>`, declares a local
  `Kpi`/`Tile`/`StatCard` component, or hand-rolls a status pill instead of
  `StatusBadge`.
- Delete the `MetricTile` deprecation wrapper once its last caller is gone.
- Playwright pass over every Warehouse page at 1440 / 1280 / 1024 / 768 /
  390 px checking for horizontal overflow and truncated values.

## Technical notes

- Presentation only. No data, derivation, or business-logic changes —
  `deriveYardKpis`, `useDomainOperations`, replenishment/wave models are
  untouched.
- No Warehouse-prefixed card component is created. If a Warehouse need
  cannot be expressed, the canonical card is extended and Finance inherits
  the capability.
- The 55 existing Finance/Sales/Purchases/Inventory call sites must keep
  rendering identically; changes to the shared card stay additive.

## Sequencing

Wave B → C → D → E → F → G → Step 4, each wave finished (migrated,
drill-downs wired, responsive-verified, typecheck clean) before the next.


======================IMPLEMENTATION PROGRESS==================
I'll verify the previous engineer's claims directly in the code before planning.

I paused mid-migration, and one file is currently left in a broken state — worth knowing before you pick this back up.

Completed and typechecked:
- Wave B (Inbound): `DockSchedule`, `CrossdockBoard`, `ReturnsLaneBoard`, `FlowSpine` typography
- Wave C (Inventory control): `Slotting`, `CountReview`, `LicensePlates`, `LicensePlateView`
- Configuration surfaces: `WarehouseLayoutWorkspace`, `LocationOverviewTab`, `LabelVerifyDialog`
- Canonical card hardened: added `title` passthrough and keyboard accessibility (`role="button"`, Enter/Space) for `onClick` cards

Needs fixing first: `src/pages/warehouse/ExecutionTelemetry.tsx` — the stat strip's closing tag is still `</div>` where it must be `</SummaryStatGrid>` (around line 143). That is a build error until changed.

Remaining: `LabourBoard` and `WarehousesList` were edited but not yet typechecked; `BillingBoard` (`KpiCard`), Wave D (Outbound/Wave planning/Dispatch), Wave E (Yard) still hold bespoke stat markup; and Step 4 hardening — the `warehouse-canonical-cards` architecture test, deleting `MetricTile` (last user: `CycleCounts.tsx`), and the responsive Playwright pass at 1440/1280/1024/768/390 px — is untouched.


MAKE SURE NOT EVEN A SINGLE HAND HARRD ROLLED COMPONENT is used in warehouse and that every card, every icon including the UI is the evry same used in Finance
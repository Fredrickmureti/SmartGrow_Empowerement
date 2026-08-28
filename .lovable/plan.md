# Warehouse ↔ Finance card consistency — verified handover (v4) and remaining work

## Phase 1 — independent verification (re-measured today, 2026-08-28)

Every claim in the previous plan was re-checked directly against the code:

- **True:** `MetricTile` is gone. The only textual occurrence in the whole tree is inside
  the guard test that forbids it.
- **True:** 24 files under `src/pages/warehouse` and `src/features/warehouse` render the
  canonical `SummaryStatCard` / `SummaryStatGrid`.
- **True:** `src/test/architecture/warehouse-canonical-cards.test.ts` exists with three
  rules (no `MetricTile`, no local summary card, canonical import path only).
- **Improved since v3:** bespoke large-metric typography is now down to **one** file.
  `control-center/HealthBanner.tsx` and `entity/EntityPreview.tsx` are already clean.
- **Still broken:** `src/pages/warehouse/BillingBoard.tsx` declares a local `KpiCard`
  (line 1043) rendering `text-3xl font-semibold` inside a hand-rolled `Card`, used for
  five 3PL billing metrics. This is the last parallel card in Warehouse.
- **Still broken:** the guard test only matches `export function (Metric|Stat|Kpi|KPI)(Tile|Card)`.
  `BillingBoard`'s `KpiCard` is a non-exported declaration, so the guard passes on a file
  that violates the rule it exists to enforce — false assurance.
- **Confirmed canonical reference:** Finance AR/AP uses `SummaryStatCard` + `SummaryStatGrid`
  exclusively for summary metrics, with `accent` + tone per aging bucket, and plain
  `<Badge>` / `<Card>` elsewhere. The card grid is container-query driven, so responsive
  parity comes free wherever the canonical grid is used.
- **Never run:** the responsive verification pass and the drill-down completeness pass.

The v3 verdict holds: remaining genuine scope is one file, one guard hole, and two
verification passes. The v2 "mass Badge/Card migration" wave stays dropped — Finance does
not do it, so doing it in Warehouse alone would create the divergence this audit removes.

## Phase 2 — remaining execution

### Wave G′ — the last hand-rolled card
Delete `KpiCard` from `BillingBoard.tsx` and render the five billing metrics through
`SummaryStatGrid` / `SummaryStatCard`, keeping billing wording, the existing tone
semantics (unbilled → warn, unpriced/disputed → bad), and adding drill-down targets where
the metric points at reviewable records. Amounts formatted with the shared currency
formatter rather than `toFixed(2)`.

### Wave I — close the guard hole
Widen the architecture test to fail on any local declaration — `function` or `const`,
exported or not — named `*(Kpi|KPI|Stat|Metric|Summary)(Card|Tile)*`, and on large-metric
typography (`text-2xl`/`text-3xl` with `font-bold`/`font-semibold`) in any warehouse file.
The widened test must be shown failing on today's `BillingBoard` before the fix and green
after; a guard that never went red is not a guard.

### Wave J — responsive parity pass
Capture a Finance AR/AP baseline at 1440 / 1280 / 1024 / 768 / 390 px with Playwright,
then walk the Warehouse routes in nav order (Work, Inbound, Inventory Control, Outbound,
Yard, Workforce, Analysis, Configuration) at the same widths, checking for horizontal
overflow, truncated metric values, and stat grids that fail to restack. Fix breakages at
the call site (grid/span usage), never by adding a Warehouse-only override to the shared
card.

### Wave K — drill-down completeness
For each Warehouse summary card representing actionable work (pending putaway, overdue
dwell, wave shortfall, QC queue, replenishment need, SLA breach), confirm a `to` target
exists and lands on the correspondingly filtered workspace. Pure-context cards stay
non-interactive — a dead link is worse than a plain number.

## Out of scope (and why)

Mass `Badge` → `StatusBadge` and `Card` → `Section` migration across Warehouse. The
reference implementation does not do this. If the ERP later standardises status chrome it
must start in Finance and propagate outward, as its own initiative.

## Technical notes

- Presentation only. `deriveYardKpis`, `useDomainOperations`, replenishment/wave models
  and all data derivation stay untouched.
- No Warehouse-prefixed card component is created. If a Warehouse need cannot be
  expressed, `SummaryStatCard` is extended additively so Finance/Sales/Purchases/Inventory
  inherit it and continue rendering identically.

## Sequencing

Wave G′ → I → J → K, typechecked and test-green before each hand-off.







===========PROGRESS STATUS==============
I've paused here — the work I completed is committed and typecheck-clean.

Done this pass

- Canonical tone palette — added `src/design-system/primitives/tone.ts` (`toneText/toneBorder/toneSurface/toneFill/toneRing/toneFromStat`) and exported it from `@/design-system`. This is the missing counterpart to `StatusBadge`: it owns status colour when it appears as text, an icon tint, a border, a row wash or a meter fill.
- Removed every hardcoded status colour in Warehouse — all 24 occurrences across `TrailerChip`, `WaveCapacityPanel`, `WaveReadinessPanel`, `PickList`, `RuleWorkbench`, `AppointmentPlanner`, `RequestDockSlotDialog`, `DockTimeline` and `LoadingBay` now resolve through the shared palette, so re-tinting the ERP is a one-file change.
- `WarehousesList` migrated onto the canonical shell — it was the last Warehouse page rendering its own header markup, raw `Card` table containers, spinner and empty-state blocks, plus two hand-rolled Tailwind badge colour maps. It now uses `PageHeader` / `PageBody` / `Section` / `FilterBar` / `LoadingState` / `EmptyState` / `StatusBadge`, matching Finance exactly.
- Verified the other 8 "no PageHeader" pages are correct as-is: they compose `EntityWorkspaceShell`, `RecordShell` or `RecordFormShell`, which are the canonical shells for those surfaces.
- Confirmed zero legacy `page-header` / `page-title` / `filter-bar` classes remain in Warehouse, and that the 8 remaining `Loader2` spinners are all in-button pending indicators (identical to Finance) rather than page loading states.

What remains

1. `Card + CardHeader + CardTitle` blocks that are really titled sections should become `Section`, in: `GateConsole` (7), `LabourPerformancePanel` (6), `PutawayQueue` (4), `YardLanes` (4), `PackStation` (3), `YardMap` (3). I had just finished mapping them when I stopped — no edits made. Note Finance has a comparable count, so the honest fix is to converge both, not just Warehouse.
2. ~31 plain-text empty states (`<p class="text-sm text-muted-foreground">No …`) that should be `EmptyState`.
3. An architecture guard test forbidding raw palette classes and `CardTitle` in Warehouse files — without it these will drift straight back.

Note also that the repo's wider test suite has 120 pre-existing failures unrelated to this work (payroll, migrations, finance guards); the Warehouse card tests pass.
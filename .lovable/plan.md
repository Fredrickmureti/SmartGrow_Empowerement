# Warehouse ↔ Finance card consistency — verification verdict (2026-08-28, new owner) and remaining work

## Phase 1 — independent verification of the previous engineer's claims

Re-checked directly in the codebase, not taken on trust:

- **Confirmed true — Wave G′ (last hand-rolled card):** `BillingBoard.tsx` no longer
  contains a local `KpiCard` or `text-3xl` metric typography. No matches remain.
- **Confirmed true — Wave I (guard hole closed):** `src/test/architecture/warehouse-canonical-cards.test.ts`
  now matches any local declaration (`function`/`const`/`class`, exported or not) named
  like a stat card, plus bespoke large-metric typography. One documented exemption
  (`TowerSummaryCard`, a genuine composite panel).
- **Confirmed true — tone palette:** `src/design-system/primitives/tone.ts` exists and is
  exported from `@/design-system`; Warehouse status colour resolves through it.
- **Confirmed true — canonical shells:** Warehouse pages compose `PageHeader` / `PageBody` /
  `Section` / `FilterBar` / `LoadingState` / `EmptyState` / `StatusBadge`, and
  `EmptyState` is already used in 62 Warehouse files.
- **Confirmed still pending — titled-section drift:** 29 `CardTitle` occurrences remain in
  Warehouse across `GateConsole` (7), `LabourPerformancePanel` (6), `PutawayQueue` (4),
  `YardLanes` (4), `PackStation` (3), `YardMap` (3), `TowerSummaryCard` (2).
- **Confirmed still pending — empty states:** 29 plain-text `No …` paragraphs that should
  be `EmptyState`.
- **Confirmed still pending — no guard** forbidding raw palette classes or `CardTitle` in
  Warehouse.
- **Confirmed never run:** Wave J (responsive parity) and Wave K (drill-down completeness).
- **New finding the previous engineer understated:** Finance is *not* clean on this axis
  either — 55 `CardTitle` occurrences across Finance pages, including the reference
  workspaces (`AccountsPayable` 3, `AccountsReceivable` 1). Converging Warehouse alone
  would create a new divergence. AR/AP, as the declared canonical reference, must be
  converged in the same pass.

Verdict: Waves G′ and I are genuinely done. Resume at the titled-section convergence, then
Waves J and K.

## Phase 2 — remaining execution

### Wave L — titled sections converge on `Section` (Warehouse **and** AR/AP)
Replace `Card + CardHeader + CardTitle` blocks that are really titled sections with the
canonical `Section` primitive in the seven Warehouse files above, and in
`AccountsReceivable.tsx` / `AccountsPayable.tsx` so the reference itself is canonical.
`TowerSummaryCard` keeps its composite structure but adopts `Section` chrome. Purely
presentational change — no data derivation touched.

### Wave M — empty states
Convert the 29 plain-text `No …` paragraphs to `EmptyState`, with Warehouse-specific
wording and, where the emptiness is actionable (nothing in the putaway queue vs. no
matching filter), the appropriate action or filter-reset affordance.

### Wave N — guard against re-drift
Extend the Warehouse architecture test to fail on raw Tailwind status palette classes
(`text-red-*`, `bg-amber-*`, …) and on `CardTitle` in Warehouse files. The guard must be
demonstrated red before Wave L lands and green after; a guard that never failed proves
nothing.

### Wave J — responsive parity pass
Playwright baseline of Finance AR/AP at 1440 / 1280 / 1024 / 768 / 390 px, then the
Warehouse routes in nav order (Work, Inbound, Inventory Control, Outbound, Yard,
Workforce, Analysis, Configuration) at the same widths. Check horizontal overflow,
truncated metric values, stat grids that fail to restack, and tables inside cards. Fix at
the call site (grid/span usage), never with a Warehouse-only override on a shared card.

### Wave K — drill-down completeness
For every Warehouse summary card representing actionable work (pending putaway, overdue
dwell, wave shortfall, QC queue, replenishment need, SLA breach), confirm a `to` target
exists and lands on the correspondingly filtered workspace. Pure-context cards stay
non-interactive — a dead link is worse than a plain number.

## Out of scope (and why)

Mass `Badge` → `StatusBadge` migration across Warehouse. The reference implementation does
not do it; doing it in Warehouse alone recreates the divergence this audit removes.

## Technical notes

- Presentation only. `deriveYardKpis`, `useDomainOperations`, replenishment/wave models and
  all data derivation stay untouched.
- No Warehouse-prefixed card component is created. If a Warehouse need cannot be expressed,
  `SummaryStatCard` is extended additively so Finance/Sales/Purchases/Inventory inherit it
  and keep rendering identically.
- The repo has ~120 pre-existing unrelated test failures (payroll, migrations, finance
  guards). Baseline them before each wave so regressions stay attributable.

## Sequencing

Wave N (red) → L → N (green) → M → J → K, typechecked and Warehouse-test-green at each
hand-off.

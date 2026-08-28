# Warehouse ↔ Finance card consistency — verification verdict and completion plan (v3)

## Phase 1 — verification of the previous engineer's log (done, against the code)

**Confirmed true**

- `ExecutionTelemetry.tsx` is repaired — `<SummaryStatGrid>` now closes with
  `</SummaryStatGrid>` (lines 134–143). Wave 0 is genuinely done.
- `MetricTile` is gone: the only remaining textual occurrence in the whole tree is
  inside the guard test that forbids it. `CycleCounts` was migrated.
- `src/test/architecture/warehouse-canonical-cards.test.ts` exists and enforces three
  rules (no `MetricTile`, no local summary card, canonical import path only).
- Canonical-card adoption is real and grew: **24** files under `pages/warehouse` /
  `features/warehouse` import `SummaryStatCard`/`SummaryStatGrid`.
- Bespoke metric typography has genuinely collapsed — the previously claimed "39 files"
  is now **3**: `BillingBoard.tsx`, `control-center/HealthBanner.tsx`,
  `entity/EntityPreview.tsx`.

**Confirmed broken / not done**

- `pages/warehouse/BillingBoard.tsx` still declares a local `KpiCard` at line 1043 and
  still renders bespoke large-metric typography. This is the last true parallel card.
- The guard test has a hole that let `BillingBoard` through: it only matches
  `export function (Metric|Stat|Kpi|KPI)(Tile|Card)`. `BillingBoard`'s `KpiCard` is a
  non-exported `function` declaration, so the guard passes on a file that violates the
  rule it exists to enforce. The guard is currently giving false assurance.
- No responsive pass has been run at any viewport.

**Wave H in the v2 plan is wrong and must be dropped**

Measured directly on the reference implementation:

| | AR | AP |
|---|---|---|
| `<Badge>` usages | 8 | 7 |
| `StatusBadge` usages | 0 | 0 |
| hand-rolled `<CardContent>` | 2 | 2 |
| `SummaryStatCard`/`Grid` usages | 9 | 9 |

Finance AR/AP is canonical **only for summary metrics** — there it uses
`SummaryStatCard`/`SummaryStatGrid` exclusively, with no bespoke metric typography.
For status pills and non-metric panels it uses raw `<Badge>` and raw `<Card>`.
Rewriting Warehouse's 47 `<Badge>` files to `StatusBadge` and its 19 `<CardContent>`
files to `Section` would make Warehouse *diverge* from the stated reference, not match
it. That work is not justified by the parent prompt's "match Finance" objective.

Verdict: Waves 0, D and E are real. The remaining genuine scope is much smaller than v2
claimed — one file, one guard hole, and the responsive parity pass that has never run.

## Phase 2 — remaining execution

### Wave G′ — the last hand-rolled card
- `BillingBoard.tsx`: delete the local `KpiCard`, render its metrics through
  `SummaryStatGrid`/`SummaryStatCard` with the same tone/footer/drill-down vocabulary the
  migrated Warehouse pages already use. Billing wording stays billing wording.
- `control-center/HealthBanner.tsx` and `entity/EntityPreview.tsx`: these are composite
  surfaces, not stat strips. Reduce their metric typography to the canonical card's
  metric treatment so number rendering matches Finance, without wrapping a banner or a
  hover preview in a stat grid where it does not belong.

### Wave I — close the guard hole
Widen `warehouse-canonical-cards.test.ts` so it fails on any local declaration —
`function`, `const`, exported or not — whose name matches `*(Kpi|KPI|Stat|Metric|Summary)(Card|Tile)*`,
and on any large-metric class (`text-2xl`/`text-3xl` + `font-bold`/`font-semibold`) inside
a warehouse file that is not the canonical card itself. Confirm the widened test fails on
today's `BillingBoard` before the fix and passes after — a guard that never went red is
not a guard.

### Wave J — responsive parity pass (never run)
Capture a Finance AR/AP baseline at 1440 / 1280 / 1024 / 768 / 390 px via Playwright,
then walk every Warehouse route in the ADR-0121 nav order (Work, Inbound, Inventory
control, Outbound, Yard, Workforce, Analysis, Configuration) at the same widths, checking
for horizontal overflow, truncated metric values, and stat grids that fail to restack.
Fix breakages by correcting grid/span usage at the call site — never by adding a
Warehouse-only responsive override to the shared card.

### Wave K — drill-down completeness
For each Warehouse `SummaryStatCard` that represents actionable work (pending putaway,
overdue dwell, wave shortfall, QC queue, replenishment need, SLA breach), confirm a `to`
target exists and lands on the correspondingly filtered workspace. Cards that are pure
context stay non-interactive — a dead link is worse than a plain number.

## Explicitly out of scope (and why)

- Mass `Badge` → `StatusBadge` and `Card` → `Section` migration across Warehouse.
  The reference implementation does not do this; adopting it in Warehouse alone creates
  the divergence the audit is meant to remove. If the ERP later standardises status
  chrome, it must start in Finance and propagate outward, as its own initiative.

## Technical notes

- Presentation only. `deriveYardKpis`, `useDomainOperations`, replenishment/wave models
  and all data derivation stay untouched.
- No Warehouse-prefixed card component is created. If a Warehouse need cannot be
  expressed, `SummaryStatCard` is extended additively and Finance inherits it; existing
  Finance/Sales/Purchases/Inventory call sites must render identically.

## Sequencing

Wave G′ → I → J → K, typechecked and test-green before each hand-off.

## Notes for the next agent

Verify before trusting: this v3 assessment was measured with `rg` counts on
`src/pages/warehouse`, `src/features/warehouse`, and the two Finance reference pages.
Re-run those counts before assuming any wave above is still outstanding.

# Enterprise Reporting Workspace — Verification Verdict and Completion Plan

## Phase 1 — Verification of the previous engineer's claims

Checked directly in the codebase, not against the log.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Column projection owned by `_shared/reports/resolveColumns.ts`, called on every tabular exit path | Confirmed | `render-report/index.ts` calls `resolveReportColumns` at the JSON, server-build CSV/XLSX and prebuilt branches |
| `logReportRun` on every rendition path | Confirmed in code (6 call sites); rows not re-queried this round | same file |
| `buildRenderPayload` omits client rows/columns in server-build mode | Confirmed | `ReportExportService.ts` comments + branch structure |
| Typed empty states (`ReportEmptyState`, `emptyState` prop) | Confirmed but **adopted only by the payroll viewer**; finance pages still pass bare strings | `ReportPageLayout.tsx` |
| Report registry is single source of truth | Partly true. It exists and is consumed by palette/Report Center, but it only covers ~32 Finance/Tax/Inventory reports — Payroll, POS, Projects, CRM, HR and WMS reports are absent | `ReportRegistry.ts` |
| HR report library is stubs (classification F) | Confirmed | `HrReportsRoutes.tsx` is entirely `WorkspaceComingSoon` |

**Verdict on scope:** the previous workstream solved *export/audit parity* correctly. It did **not** address the parent prompt's actual objective — the reporting *workspace*: library state, report switching, context-aware back, state model, and drill-down beyond Finance. Those remain open, and the previous plan's "Phases 1–9 complete" is complete only for its own narrower charter.

## Current state of the workspace objective

- Drill-down exists only as `DrillDownDialog` used by 9 Finance pages (dialog-based, so context survives) — **D1 for Finance, D3 elsewhere** (Payroll, Sales, Purchases, Inventory, POS, Projects, CRM have no drill-down).
- No workspace state model: filters are component `useState` in nearly every page; only `FinancialReports`, `AgingReport`, `GeneralLedger` read URL params, and none *write* them. Returning to a report reconstructs from scratch — **D2 risk on every route-based navigation**.
- No report switching: moving between related reports requires the sidebar or library round-trip.
- No related-reports metadata anywhere in the registry.
- Library (`/reports`) has no retained category/search/scroll state.

## Target architecture

```text
Common reporting infrastructure
  reportRegistry (+ domain, relatedReports, drillDown capability)
  useReportWorkspaceState  — URL-backed scope/filter state, one owner
  ReportPageLayout         — adds report switcher + related reports + typed empty state
  DrillDownDialog          — stays the drill-down primitive (context-preserving by design)
Domain layers
  finance / payroll / sales / purchases / inventory / pos / projects / crm
  each supplies columns, grouping, totals, and its own legitimate drill paths
```

## Phase plan

### Phase A — Registry becomes the workspace spine
Extend `ReportDefinition` with `domain`, `relatedReports: string[]`, `drillDown: "none" | "dialog" | "route"`, and register the Payroll, Sales, POS, Projects, CRM and Inventory report surfaces that exist today but are unregistered. Test: every routed report page has a registry entry (extend `reports-registry-key-coverage.test.ts`).

### Phase B — Report workspace state model
Add `useReportWorkspaceState` (URL search params as the single carrier for period/date range/business/branch/grouping/sort/search; transient UI state stays local). Migrate Finance pages first, then Payroll viewer. Back/forward and drill-return then work through normal history with no history hacks. Test: state round-trip guard asserting pages read *and* write their scope through the hook, not local `useState`.

### Phase C — Report switching + related reports
`ReportPageLayout` renders a domain-scoped switcher strip (siblings from the registry) and a "Related reports" affordance that carries the current scope forward via the Phase B params. Test: switcher only shows same-domain/related entries; scope params survive a switch.

### Phase D — Library becomes a workspace
`/reports` (and the Payroll Reporting Centre) retain selected category, search query and scroll position via URL params + restoration, plus a recent-reports list sourced from `report_run_log`. Test: library state guard.

### Phase E — Drill-down beyond Finance
Only where the schema supports real ownership, verified per domain before implementing:
- Payroll: branch/department cost → employees in run → payslip → payslip lines (`payslipDrillDown.ts` already exists and is reused).
- Sales: customer → invoice → lines → payment.
- Purchases: supplier → bill → lines → payment.
- Inventory: product → movements → source transaction → valuation layer.
- POS: shift → transaction → payment → receipt.
All drill queries run through existing scoped hooks so RLS, branch and payroll permissions apply unchanged; no new privileged reads. Anything without a legitimate relationship is classified D0/D4 and left alone. Test: per-domain drill contract tests + an authorization guard test that drill queries are scoped.

### Phase F — Adopt typed empty states
`AgingReport`, `AuditTrail`, `BudgetReport`, `CashFlowReport`, `DepreciationReport`, `BankReconciliationReport`, `AccountRegister` move from `emptyMessage` string to typed `emptyState`. Test: extend `report-empty-state-semantics.test.ts` to forbid bare strings on these pages.

### Phase G — `report_run_log` reader
Admin-facing report-run history surface (actor, org, business, period, rows, rendition) — the audit trail currently has no reader.

### Phase H — Performance and narrow viewport
Keep aggregation server-side; add virtualization/pagination only where a report can exceed a few thousand rows, frozen identifier column and horizontal scroll on narrow screens (no hiding of figures).

## Notes
- No new reporting engine, no PDF changes, no accounting/payroll computation changes.
- HR's question-driven library and WMS reporting stay classification F: reports will not be fabricated to fill navigation.
- Each phase ships with its tests and is independently revertable.

# Inventory reporting — one catalogue, reachable from both Finance and Inventory

## What I found

Inventory reports are registered once in `REPORT_REGISTRY`, but each one is
hard-bound to a single URL prefix, and half of them live under Finance while the
other half live under Inventory:

| Report | Registered path |
| --- | --- |
| Stock Reports (hub) | `/finance/reports/stock` |
| Stock Adjustments | `/finance/reports/stock-adjustments` |
| Stock Transfers | `/finance/reports/stock-transfers` |
| Inventory ⇄ GL Reconciliation | `/finance/reports/inventory-gl-reconciliation` |
| Inventory Valuation | `/inventory-app/reports/valuation` |
| Stock Ledger | `/inventory-app/reports/ledger` |
| Stock Aging | `/inventory-app/reports/aging` |
| Lot Traceability | `/inventory-app/reports/lot-traceability` |

Three consequences, which are exactly the symptoms reported:

1. The Finance sidebar's "Inventory" family is built from
   `REPORT_FAMILIES.inventory` = `stock-reports`, `stock-adjustments-report`,
   `stock-transfers-report` — the three Finance-hosted ones. Valuation, Ledger,
   Aging and Lot Traceability are missing from the sidebar even though the
   horizontal strip and the hub pages surface them.
2. Clicking Valuation / Aging / Ledger / Lot Traceability from Finance navigates
   to `/inventory-app/...`, which swaps the whole app shell. Clicking Stock
   Adjustments / Transfers / GL Reconciliation from Inventory throws the user
   back into Finance. Users ping-pong between shells.
3. The two sidebars and the horizontal `ReportsSubNav` (driven by
   `REPORTS_APP.modules`, which lists only `stock`) disagree about what the
   inventory report catalogue even contains.

No report is duplicated in code — the same page components are already shared.
Only the routing/link layer is single-host.

## The fix — host-aware report paths (one implementation, two mounts)

Keep exactly one page component and one registry row per report. Give each
inventory-category report **two mount points** and resolve links against the
shell the user is currently in, so navigation never leaves the app.

1. **Registry**: add an optional `paths: { finance: string; inventory: string }`
   to inventory-category rows (`path` stays as the canonical/default so search,
   scheduling and run-history keep working unchanged).
2. **Resolver**: `resolveReportPath(def, pathname)` in
   `src/services/reports/reportsNav.ts` — returns the inventory-prefixed URL when
   `pathname` starts with `/inventory-app`, otherwise the Finance one.
3. **Routes**: mount the four Inventory-hosted pages under
   `/finance/reports/*` as well, and the three Finance-hosted inventory pages
   (plus Inventory ⇄ GL Reconciliation) under `/inventory-app/reports/*`. Same
   lazy component imports — no copied pages.
4. **Finance sidebar**: extend the `inventory` family in `REPORT_FAMILIES` to all
   eight reports, emitted with Finance paths.
5. **Inventory sidebar**: rebuild the Insights group from the same registry
   family via a `buildInventoryReportsNavChildren()` helper, so it lists the same
   eight reports with `/inventory-app` paths — replacing today's hand-written
   list and the cross-app deep link to Finance.
6. **Horizontal strip + hubs**: add the missing inventory modules to
   `REPORTS_APP.modules` so the tab strip matches the sidebar, and route the
   Report Center / Stock Reports hub cards through `resolveReportPath` so a card
   opened from Inventory stays in Inventory.
7. **Redirects**: keep every existing URL working — old links resolve to the
   same page under whichever shell they name.

## Guardrails

New architecture test `src/test/architecture/inventory-reports-dual-host.test.ts`:

- every `category: "inventory"` report appears in both the Finance nav and the
  Inventory nav;
- no nav item in `src/apps/inventory/nav.ts` points at `/finance/...` and no
  inventory family entry in the Finance nav points at `/inventory-app/...`;
- both mount points exist in the route files for each inventory report;
- no report page component is imported by more than one file per shell (no
  duplicate implementations).

Existing inventory report tests (valuation basis, lot traceability, GL
reconciliation, operations-reports-server-owned) must stay green — this wave
touches navigation and routing only, no report SQL or accounting logic.

## Files touched

- `src/services/reports/ReportRegistry.ts` — dual paths for inventory rows
- `src/services/reports/reportsNav.ts` — resolver + inventory family + inventory nav builder
- `src/apps/inventory/nav.ts` — registry-driven Insights group
- `src/apps/inventory/routes.tsx`, `src/apps/finance/routes.tsx` — second mounts
- `src/lib/apps/registry.ts` — `REPORTS_APP.modules` completion
- `src/pages/finance/ReportCenter.tsx`, `src/pages/reports/StockReports.tsx` — host-aware links
- `src/test/architecture/inventory-reports-dual-host.test.ts` — new ratchet
- `docs/architecture/decisions/` — short ADR recording the dual-host rule

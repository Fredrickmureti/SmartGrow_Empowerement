# ADR 0143 — Inventory reports are one catalogue mounted in two shells

- Status: accepted
- Date: 2026-08-20

## Context

`REPORT_REGISTRY` binds each report to exactly one URL. Inventory reports were
split across two owners: the hub, adjustments, transfers and the ⇄ GL
reconciliation lived under `/finance/reports/*`, while valuation, stock ledger,
aging and lot traceability lived under `/inventory-app/reports/*`.

Consequences observed in the product:

- The Finance sidebar's Inventory family only listed the three Finance-hosted
  reports, while the horizontal strip and the Report Center surfaced all of
  them — sidebar and content disagreed.
- Clicking valuation/aging/ledger/lot traceability from Finance swapped the
  whole app shell; clicking adjustments/transfers/GL reconciliation from
  Inventory bounced the user back into Finance.

Both shells are legitimate homes: the accountant reaches stock valuation from
the Finance report catalogue, the stock controller reaches it from Inventory.

## Decision

An inventory report has **one implementation, one registry row, two mounts**.

1. Registry rows carry `paths: { finance, inventory }`; `path` stays the
   canonical URL used by search, scheduling and run history.
2. `resolveReportPath(def, pathname)` picks the mount matching the shell the
   user is in — navigation never crosses the app boundary.
3. Route files mount the *same* lazy page component under both prefixes. Copying
   a report page is forbidden.
4. `REPORT_FAMILIES.inventory` is the single list of inventory reports; the
   Finance sidebar renders it with Finance paths, the Inventory sidebar with
   `buildInventoryReportsNavChildren()`.
5. `findReportByPath` / the report view logger match on any mount path.

This does not contradict ADR 0101: nav is not swapped, each app keeps its own
single nav — only the report URL is host-relative.

## Consequences

- No duplicated reports, no cross-app jumps, sidebar/strip/hub agree.
- Legacy URLs keep working; both prefixes resolve to the same page.
- Enforced by `src/test/architecture/inventory-reports-dual-host.test.ts`.

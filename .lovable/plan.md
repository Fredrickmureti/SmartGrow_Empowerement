# Microfinance convergence — authoritative status (29 Aug 2026)

Roadmap: `.lovable/plan/microfinance-convergence-independent-verification-29-aug-202-2026-08-29.md`

- **M0 Runtime repair — DONE.** `GET /` → 200, shell renders, typecheck clean.
- **M1 PIN re-verification — DONE as far as possible.** `check_pin_status` probe answers
  `has_pin: true` for the seeded super admin on `/login`. Full PIN submission is not
  exercisable: external/BYO Supabase, no mintable session and no PIN available.
- **M2b Residue closure — DONE.** Timesheet/kiosk/payroll residue outside `src/apps`
  removed; only enum-bound `payroll_processed` (SMS) and retired-app comments remain.
- **M3 ERP disposition — IN PROGRESS (code side done).**
  - Dropped from `REPORT_REGISTRY` + reports nav (routes already removed):
    `stock-reports`, `inventory-valuation`, `stock-ledger`, `stock-aging`,
    `lot-traceability`, `stock-adjustments-report`, `stock-transfers-report`,
    `inventory-gl-reconciliation`, `pos-reports`, `project-reports`,
    `project-full-export`. Inventory nav family removed.
  - Routing-parity, reporting-workspace, reporting-isolation, cash/banking coherence
    and report-format parity suites: green.
  - Command palette: `providers/invoices.ts`, `providers/products.ts` deleted and
    unregistered; orphan `useProductCategories`, `useProductTrackingFlags` deleted.
    Typecheck clean.
  - **Blocking discovery (29 Aug).** The live database has **51 tables**; the source
    tree queries **hundreds**. 319 files under `src/` call `.from("<table>")` for a
    table that does not exist in this project (inventory, WMS, purchasing, POS,
    platform-billing, CRM, banking-reconciliation, payment-terms, price-lists…).
    So `invoices` / `invoice_items` / `products` are not the residue — they are three
    of the few ERP tables that *do* exist. A per-table drop wave is the wrong unit of
    work; the real decision is whether to (a) mass-excise the unbacked code down to
    the 51 real tables, or (b) rebuild the microfinance schema first and excise after.
  - Also pending: ADAPT `contacts` → client/member master (M3), and the ~115 stale
    guard tests inherited from the removed ERP domains.

- **M4+** unchanged: institution settings, CoA + account mapping, workspace scaffold,
  domain waves.

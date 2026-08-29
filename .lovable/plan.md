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
  - **Pending review before execution:** dropping `invoices`, `invoice_items`,
    `products` in the database. All three are empty (0 rows), but ~46 source files
    still query them (AR pages, dashboards, statements, command palette, delivery
    notes). The sales surfaces must be retired in the same wave, one small migration
    at a time, or those screens will fail at runtime.
  - Also pending: ADAPT `contacts` → client/member master (M3), and the ~115 stale
    guard tests inherited from the removed ERP domains.
- **M4+** unchanged: institution settings, CoA + account mapping, workspace scaffold,
  domain waves.

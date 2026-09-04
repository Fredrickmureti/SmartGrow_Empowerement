# Roadmap

Authoritative detail lives in `.lovable/plan.md`.

- [x] ERP strip (code side closed — remaining ERP objects are inert).
- [x] Microfinance domain end-to-end (clients → groups → products →
      applications → approval → loans → disbursement → schedules → repayments →
      collections → arrears/PAR → top-up/restructure/write-off/closure).
- [x] Report catalogue retargeted to microfinance (FX / aged AR / aged AP out).
- [x] Studio entity catalogue migrated off the ERP entity list.
- [x] DB slimming batch 1 (consolidation, HR extras, retail/POS, warehouse,
      scanner, sales pricing engine).
- [ ] M1 — Owner verification pass in the running app.
- [ ] M2 — Remove orphaned FX report pages/routes and stale references.
- [ ] M3 — Statements & settlement engine fully microfinance-worded.
- [ ] M4 — Dead ERP table groups dropped (one migration per group).
- [ ] M5 — Orphan function purge.
- [ ] M6 — Linter posture on retained schema.

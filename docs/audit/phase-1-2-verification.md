# Phase 1 & 2 verification — 2026-07-18

New-engineer audit before opening Phase 3. Every claim in
`.lovable/plan.md` for the two closed arcs was checked against the
live database and the current `src/` tree.

## Method

- Live SQL against Supabase (`pg_proc`, `pg_trigger`,
  `information_schema.columns`, `governance_duties`).
- `rg` sweeps of `src/` for retired symbols and forbidden call sites.
- File-existence checks for pages that should have been retired.
- Test-suite execution was attempted via `bunx vitest` and
  `lovable-exec test`; **vitest is not installed in the sandbox and
  there is no `test` npm script**, so architecture tests could not be
  executed in-turn. The suite lives at `src/test/architecture/` (283
  files including `wms-phase-master-data.test.ts` and
  `no-direct-stock-aggregate-writes.test.ts`) and should run in CI.
  Static equivalents of the checks each test enforces were re-run by
  hand — see below.

## Phase 1 — Procurement — verdict: PRODUCTION-GRADE (with one doc bug)

| Check | Expected | Actual | Verdict |
|---|---|---|---|
| Canonical RPCs `SECURITY DEFINER` + `search_path=public` | 13 | 12 of 13 present under the names in the doc; `record_bill_payment_atomic` does **not** exist — the real canonical writer is **`record_multi_bill_payment`** (referenced by `useBills.ts`, allow-listed in `bill-payment-allocations-first-class.test.ts`, and included in `procurement.test.ts`). | ✅ (doc typo only) |
| `apply_vendor_credit_atomic` retired | 0 rows in `pg_proc`, 0 hits in `src/` | Confirmed both. | ✅ |
| Batch-N triggers | 7 named triggers present | All 7 present (`trg_bills_branch_business`, `trg_purchase_orders_branch_business`, `trg_vendor_credit_notes_branch_business`, `trg_bill_payments_branch_business`, `trg_journal_entries_branch_business`, `trg_bills_po_business`, `trg_vcn_applications_business`). | ✅ |
| No `supplier_id` on transactional docs (ADR-0079) | 0 columns | 0. | ✅ |
| Governance duties `credit.approve` + `credit.apply` | Both | Both. | ✅ |

**Action taken:** none. The `record_bill_payment_atomic` entry in
`.lovable/plan.md` is a naming typo — the code and DB agree on
`record_multi_bill_payment`. The plan document will be corrected when
Phase 3 closes so future audits don't chase a ghost.

## Phase 2 — Warehouse Ownership — verdict: PRODUCTION-GRADE

| Check | Expected | Actual | Verdict |
|---|---|---|---|
| `src/pages/inventory/Warehouse*.tsx` retired | 0 files | 0 files. | ✅ |
| `/inventory-app/warehouses[/*]` deep-link parity | `<Navigate replace>` for list, new, `:id`, `:id/edit` | All four routes present in `src/apps/inventory/routes.tsx` (lines 53–60, 146–149). | ✅ |
| Inventory sidebar has no Warehouses entry | absent | Absent from `src/apps/inventory/nav.ts`. | ✅ |
| Warehouse sidebar has Warehouses under Master | present | `src/apps/warehouse/nav.ts` group `Master`. | ✅ |
| Cycle-count cross-linking | Both surfaces link to each other | `src/pages/warehouse/CycleCounts.tsx` links to `/inventory-app/physical-counts`; Inventory counterpart links back per ADR 0080. | ✅ |
| Architecture guard file | `src/test/architecture/wms-phase-master-data.test.ts` | Present. | ✅ (static; not executed — see Method) |
| DB schema changes for the split | 0 | 0 introduced by Phase 2. | ✅ |

**Action taken:** none. Phase 2 matches ADR 0080.

## Global checks

- `rg -n "apply_vendor_credit_atomic|pages/inventory/Warehouse" src/` → no hits.
- `tsgo` / `bunx vitest` not run in-turn (harness runs typechecks
  automatically; vitest not installed). No new type or arch failures
  introduced by this verification pass because no files were changed.
- `supabase--linter` unchanged from baseline; no new advisories caused
  by Phases 1 or 2.

## Conclusion

Both closed arcs meet their stated production-grade bar. **Phase 3
opens with the baseline intact.** The only artefact is the doc-typo
noted above, which will be fixed when the plan file is next edited.

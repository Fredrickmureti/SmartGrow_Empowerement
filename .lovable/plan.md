# Governance Layer — Legacy ERP Cleanup (continuation wave)

The Access Group / permission reconstruction is already done: `permission_groups`
holds exactly 7 microfinance groups (Institution Admin, Branch Manager, Loan
Officer, Credit Analyst, Collections Officer/Cashier-Teller, Accountant,
Auditor), `permission_group_rules` only uses microfinance modules (clients,
loan_products, applications, loans, repayments, collections, accounting,
treasury, reports, contacts, branches, audit, settings, team), and
`src/lib/permissions.ts` documents the ERP vocabulary as deleted.

The remaining ERP residue is concentrated in the **governance layer**. This wave
removes it.

## Evidence gathered (do not repeat)

- `governance_action_registry`: **64 rows**, only ~5 belong to this institution.
  The rest are Payroll (10), HR (12), Inventory/Scrap (8), Purchases/Purchasing
  (11), Sales/POS (several), Warehouse, landed costs, requisitions, RFQ,
  supplier terms, vendor credit notes, reversal.* for bills/goods receipts.
  Referenced by `approval_route`, `assert_approval_action_keys_registered`,
  `governance_action_registry_validate_rule`.
- `src/lib/governance/selfActionCatalogue.ts`: already microfinance-clean —
  5 entries (payment.approve, journal.post, expense.approve,
  expense.approve_self_benefit, bank_account.sensitive_change). So the app and
  the database registry have diverged; the database is the stale side.
- `governance_duties` (19 rows) still carries `pos.commit`, `pos.void`,
  `pos.return`, `pos.override_price`, `pos.override_discount`,
  `refund.approve`; `governance_duty_permission_map` maps them onto modules
  `pos` and `sales`, **which no longer exist** in the permission module
  vocabulary. Lending duties (loan.request/originate/approve/disburse/
  write_off), finance duties (je.post, je.reverse, payment.*, bank.modify) and
  security duties (role.grant, user.deactivate) are correct and stay.
  `governance_sod_conflicts`: 12 rows — must be re-checked against the pruned
  duty set. Only `governance_user_duties` reads these tables.
- `governance_modules` (14 rows): `hr`, `payroll`, `pos`, `sales`, `purchases`,
  `vendor_returns`, `inventory`, `warehouse`, `fixed_assets` are ERP;
  `finance`, `banking`, `sequences`, `transactions_ledger`, `ancillaries` are
  ours. Matching `reset_module__hr`, `reset_module__pos`, `reset_module__sales`,
  `reset_module__costing`, `reset_module__fixed_assets` still exist. Read by
  `governance_list_modules`, `governance_list_unowned_tables`,
  `governance_run_teardown`, `register_governance_module`.
- Live `sod_*` triggers exist on exactly: `payments`, `journal_entries`,
  `expenses`, `bank_accounts`, `approval_rules`, `approval_history`. No ERP
  table carries a governance trigger any more.
- `self_action_policy`: **0 rows**. `approval_rules`: **0 rows**.
  `member_permission_groups`: **0 rows**. So pruning registry/duty rows carries
  **no data migration** and cannot orphan a live policy, rule or membership.
- `src/test/architecture/governance-registry-coverage.test.ts` hardcodes the 11
  ERP module keys and asserts `length === 11` — this test currently *locks the
  ERP model in place* and must be rewritten in the same wave.

## Verdict

Governance Mode / SoD / the approval engine are **retained** — a microfinance
institution genuinely needs maker-checker on approve, disburse, post, reverse
and write-off. What must disappear is the ERP *vocabulary* inside it: ERP action
keys, ERP duties, ERP module teardown entries, and the test that pins them.
The single authoritative engine stays `approval_route` / `approval_decide` plus
`governance_assert_not_self`; nothing new is built.

## Wave G-1 — Prune the action registry

- Migration: deactivate then delete `governance_action_registry` rows whose
  module is HR, Payroll, Inventory, Purchases, Purchasing, Sales, POS,
  Warehouse, purchases, or whose key starts `landed_cost.`, `scrap.`,
  `requisition.`, `rfq.`, `procurement_`, `purchase_`, `supplier_terms.`,
  `vendor_credit_note.`, `reversal.` (except reversal targets that still exist),
  `employee_loan.`, `payroll`, `timesheet.`, `leave.`, `contract.`,
  `compensation.`, `inventory.`, `credit_note.`.
- Keep and normalise the module label casing for: `payment.approve`,
  `journal.post`, `expense.approve`, `expense.approve_self_benefit`,
  `expense.submit`, `expense.void`, `reversal.expense`,
  `bank_account.sensitive_change`, `bill.approve`, `bill_payment.approve`,
  `customer_refund.approve`, `app_access.grant`.
- Add the lending keys the institution actually needs and the SoD engine
  already implies: `loan.approve`, `loan.disburse`, `loan.write_off`,
  `loan.restructure`, `repayment.reverse` — with `subject_table` pointing at the
  `mf_*` entities, replacing the HR `loan.approve` row that currently means
  *staff* loan.
- Acceptance: every key in `SELF_ACTION_CATALOGUE` and every key passed to
  `approval_route` in `src/` resolves in the registry; no registry row belongs
  to a module the app no longer has.
- Risk: `assert_approval_action_keys_registered` may fail a build if a code
  path still routes an ERP key. Grep `routeApproval(` call sites first; that
  grep is the wave's first step.

## Wave G-2 — Prune duties and the SoD conflict matrix

- Migration: delete `governance_duty_permission_map` + `governance_duties` rows
  for `pos.*` and `refund.approve`; delete `governance_sod_conflicts` rows that
  reference them.
- Re-express the remaining conflict matrix for microfinance: origination vs
  approval, approval vs disbursement, disbursement vs cash receipt, receipt vs
  GL posting, any operational duty vs `role.grant` / `user.deactivate`.
- Verify each `governance_duty_permission_map.module` value exists in the
  microfinance `PermissionModule` union; add a SQL check or an architecture test
  asserting that, so this cannot drift again.
- Acceptance: `governance_user_duties` returns only microfinance duties for the
  7 default groups; no map row references `pos`/`sales`.

## Wave G-3 — Prune the module teardown registry

- Migration: delete `governance_modules` rows `hr`, `payroll`, `pos`, `sales`,
  `purchases`, `vendor_returns`, `inventory`, `warehouse`, `fixed_assets`
  **only after** confirming `governance_list_unowned_tables()` does not then
  report live microfinance tables as unowned. Run that function *before* and
  *after* in the same session and compare.
- Drop the orphaned `reset_module__hr`, `reset_module__pos`,
  `reset_module__sales`, `reset_module__costing`, `reset_module__fixed_assets`
  once no `governance_modules.teardown_fn` names them.
- Register a `lending` module owning the `mf_*` tables so teardown/export
  coverage is complete for what we actually run.
- Risk: this registry powers workspace reset/export. Deleting a row whose
  tables still exist silently drops them from teardown. The before/after
  comparison of `governance_list_unowned_tables()` is the gate — do not skip it.

## Wave G-4 — Unpin the tests and the UI

- Rewrite `src/test/architecture/governance-registry-coverage.test.ts` to assert
  the microfinance module set (finance, banking, lending, sequences,
  transactions_ledger, ancillaries) instead of the 11 ERP keys.
- Re-run `src/test/architecture/sod-coverage.test.ts`,
  `governance-single-engine.test.ts`, `approval-engine-schema.test.ts`,
  `approval-engine-entrypoints.test.ts`, `pos-outbox-and-governance.test.ts`
  (the last one is itself ERP-era — verdict: delete if it only covers POS).
- Check the governance settings surfaces render the pruned vocabulary with no
  empty groups: `src/pages/settings/GovernanceSoD.tsx`,
  `src/components/settings/SelfActionPolicy.tsx`, `GovernanceModeCard.tsx`,
  `BlockedAttemptsQueue.tsx`, `src/hooks/governance/useGovernanceActionRegistry.ts`.

## Wave G-5 — Verify end to end

- As `fredrickmureti612@gmail.com`, open Settings → Governance and confirm the
  action list shows only lending/finance/security actions.
- Attempt a self-approval on a payment and on a loan approval; confirm refusal
  with `GOV_SELF_ACTION` and an `audit_logs` row.
- Confirm a Loan Officer cannot approve or disburse, and a Branch Manager
  cannot act on another branch's loan.

## Migration discipline

One object per migration (project rule). Order is strictly G-1 → G-2 → G-3;
each migration is delete-only against rows proven unreferenced above, so
rollback is a re-seed of the deleted rows, which each migration must include as
a commented-out INSERT block.

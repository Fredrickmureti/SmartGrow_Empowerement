# Governance + Settings — Legacy ERP Vocabulary Cleanup (continuation)

The Access Group / permission reconstruction is done: `permission_groups` holds
exactly 7 microfinance groups (Institution Admin, Branch Manager, Loan Officer,
Credit Analyst, Collections Officer/Cashier-Teller, Accountant, Auditor),
`permission_group_rules` uses only microfinance modules, and
`src/lib/permissions.ts` records the ERP vocabulary as deleted.

Remaining ERP residue sits in two places: the **governance registry tables**
(partly cleaned) and the **settings screens' wording and fields**.

## Status of the previous wave (verified 2026-09-07, do not redo)

Confirmed live against the database:

- **G-1 done.** `governance_action_registry` is now 15 rows: Lending 6, Spend 5,
  Finance 3, Platform 1. The ~50 ERP rows (payroll, HR, inventory/scrap,
  purchases, sales, POS, warehouse, landed cost, RFQ, requisitions) are gone and
  the lending keys are registered.
- **G-2 done.** `governance_duties` is 14 rows; `governance_duty_permission_map`
  now maps only microfinance modules (accounting 4, applications 3, loans 2,
  treasury 2, team 2, repayments 1) — no `pos`, no `sales`.
  `governance_sod_conflicts` is 15 rows.
- **G-3 not started.** `governance_modules` still holds the 9 ERP rows: `hr`,
  `payroll`, `pos`, `sales`, `purchases`, `vendor_returns`, `inventory`,
  `warehouse`, `fixed_assets`, alongside the 5 correct ones (`finance`,
  `banking`, `sequences`, `transactions_ledger`, `ancillaries`).
- G-4 and G-5 not started.

## Verdict (unchanged)

Governance Mode / SoD / the approval engine are **retained** — the institution
needs maker-checker on approve, disburse, post, reverse and write-off. Only the
ERP vocabulary inside it is removed. `approval_route` / `approval_decide` plus
`governance_assert_not_self` remain the single authoritative engine; nothing new
is built.

## Wave G-3 — Prune the module teardown registry

- Run `governance_list_unowned_tables()` and record the result **before** any
  delete. That output is the gate.
- Migration: delete `governance_modules` rows `hr`, `payroll`, `pos`, `sales`,
  `purchases`, `vendor_returns`, `inventory`, `warehouse`, `fixed_assets`; then
  register a `lending` module owning the `mf_*` tables.
- Re-run `governance_list_unowned_tables()` and compare. No live microfinance
  table may become unowned. If one does, extend the `lending` (or `finance`)
  ownership list instead of reverting.
- Drop `reset_module__hr`, `reset_module__pos`, `reset_module__sales`,
  `reset_module__costing`, `reset_module__fixed_assets` only once no
  `governance_modules.teardown_fn` names them.
- Risk: this registry powers workspace reset/export; a deleted row whose tables
  still exist silently drops them from teardown. Do not skip the comparison.

## Wave G-4 — Unpin tests and governance UI

- Rewrite `src/test/architecture/governance-registry-coverage.test.ts`, which
  hardcodes 11 ERP module keys and asserts `length === 11`, to assert the
  microfinance set (finance, banking, lending, sequences, transactions_ledger,
  ancillaries).
- Re-run `sod-coverage.test.ts`, `governance-single-engine.test.ts`,
  `approval-engine-schema.test.ts`, `approval-engine-entrypoints.test.ts`.
  Delete `pos-outbox-and-governance.test.ts` if it only covers POS.
- Confirm the governance surfaces render the pruned vocabulary with no empty
  groups: `src/pages/settings/GovernanceSoD.tsx`,
  `src/components/settings/SelfActionPolicy.tsx`, `GovernanceModeCard.tsx`,
  `BlockedAttemptsQueue.tsx`,
  `src/hooks/governance/useGovernanceActionRegistry.ts`.
- Extend `src/lib/governance/selfActionCatalogue.ts` (currently 5 finance/spend
  entries) with the lending keys now in the registry, so the compile-time mirror
  and the table agree again.

## Wave S — Settings vocabulary cleanup (new; the user's current complaint)

Evidence gathered 2026-09-07:

- `src/components/settings/BusinessBranchSettings.tsx` lines ~458, ~602-613 —
  editable **Invoice Prefix** and **Estimate Prefix** fields.
- `src/components/settings/BranchConfiguration.tsx` lines 50-51, 131-144 —
  carries `invoice_prefix`, `estimate_prefix`, `receipt_prefix` (POS),
  `receipt_header/footer` through the branch-override payload.
- `src/components/settings/BranchOperations.tsx` lines 9-10, 154 — header
  comment and helper text advertise "invoice prefix" and "default warehouse".
- `src/pages/settings/WorkspaceSettings.tsx` lines 340, 362, 378, 439 — copy
  referring to invoices, invoice prefixes, and "inventory from QuickBooks/Odoo".
- `src/pages/settings/AccessGroups.tsx` lines 193, 280, 304-307 — examples
  "Sales / User", "Sales View Only", and column tooltips naming timesheets,
  leave, payroll and invoices.
- Orphaned components, referenced by nothing but themselves (safe deletes):
  `src/components/settings/TaxSettings.tsx`,
  `src/components/settings/InventorySettings.tsx`,
  `src/components/settings/PaymentTermsSettings.tsx`.
- `invoice_prefix` / `estimate_prefix` have **no document-generator consumer**
  anywhere in `src/` — only these settings forms, `BusinessContext` types and
  the generated Supabase types. So they are dead UI, not live numbering.

Changes:

1. Remove the Invoice/Estimate Prefix fields from `BusinessBranchSettings.tsx`
   and drop those keys from the `BranchConfiguration.tsx` override payload and
   the `BusinessContext` interface. Do **not** invent replacement loan/receipt
   prefix fields in this wave — no numbering code reads them; loan numbering is
   already server-side.
2. Retire the POS `receipt_prefix` line in `BranchConfiguration.tsx`; keep
   `receipt_header`/`receipt_footer`, which the document engine does use for
   repayment receipts.
3. Rewrite the ERP copy in `BranchOperations.tsx`, `WorkspaceSettings.tsx` and
   `AccessGroups.tsx` in microfinance terms (loans, repayments, receipts,
   statements, client data import). Retitle the AccessGroups action-column
   tooltips: Approve → loan applications; Post → journal entries; Pay →
   disbursements and payments; Export → GL and portfolio reports.
4. Delete the three orphaned settings components. `NotificationThresholdSettings`
   is already fully removed — do not look for it again.
5. Leave the `businesses.invoice_prefix` / `estimate_prefix` columns in place
   for now; column drops belong to the later legacy-cleanup wave, and removing
   the UI is enough to end the ERP vocabulary. Log them there.
6. Verify with `bunx tsgo --noEmit` plus the build log after each file group.

## Wave G-5 — Verify end to end

- As `fredrickmureti612@gmail.com`, open Settings → Governance and confirm the
  action list shows only lending/finance/security actions.
- Walk every settings tab (Company: Company, Currency, Payments, Pay Methods,
  Email, Templates; Workspace: Profile, Appearance, Workspace, Notifications,
  Security, Access Groups, Governance, Email Delivery, Data) and confirm no ERP
  word remains on screen.
- Attempt a self-approval on a payment and on a loan approval; confirm refusal
  with `GOV_SELF_ACTION` plus an `audit_logs` row.
- Confirm a Loan Officer cannot approve or disburse, and a Branch Manager cannot
  act on another branch's loan.

## Deferred to the later legacy-cleanup wave

- Dropping `businesses.invoice_prefix`, `businesses.estimate_prefix`,
  `branches.invoice_prefix_suffix`, `branches.default_warehouse_id`.
- The inherited linter findings (security-definer views, function search paths).
- Broad orphan ERP table removal outside the authorization/governance surface.

## Migration discipline

One object per migration. Order is strictly G-3 → G-4 → S → G-5. Each migration
is delete-only against rows proven unreferenced above, and must carry its
rollback re-seed as a commented-out INSERT block.

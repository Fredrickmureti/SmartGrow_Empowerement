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



===============THIS WAS THE LAST MESSAGE FROM THE AGENT BEFORE ITS TIME RUN OUT=============


I'll start by reading the current plan and checking what remains.

Here's where things stand.

Done
- The internal module registry no longer carries the eight leftover ERP modules (HR, payroll, point of sale, sales, purchases, vendor returns, inventory, warehouse). Before removing the old "sales" entry I moved its two still-live tables — payments and payment allocations — under Finance so they keep reset/export coverage, and I registered a new Lending module owning all 20 microfinance tables.
- The branch override list lost its four ERP entries (invoice, estimate and bill number prefixes, and the point-of-sale receipt prefix). No branch had any of these set, so nothing was lost; branch logo, address, contact details and receipt header/footer remain.
- Removed the Invoice/Estimate/Bill prefix fields from the company edit form, deleted three orphaned settings screens (tax, inventory, payment terms) and a point-of-sale-only test, and rewrote the module-registry test so it asserts the microfinance modules instead of pinning the old ERP ones.

Remaining (logged for the next session)
1. Finish `BranchConfiguration.tsx` — the prefix keys are still referenced in its inherited-values block around line 129, so a type check is needed there.
2. Reword the leftover ERP copy in Branch Operations, Workspace Settings and Access Groups (mentions of invoices, warehouses, inventory imports, "Sales / User", and the payroll/timesheet column tooltips).
3. Extend the governance self-action list with the new lending actions, then run the governance and approval tests plus a type check and build.
4. Walk the settings tabs signed in as your account to confirm no ERP wording is left on screen.
5. Deferred deliberately: the old `reset_module__hr/pos/sales/costing` database routines are still called by the workspace-reset routine, so deleting them now would break reset — they belong to the later legacy cleanup, along with dropping the unused prefix columns.
---

## Wave S-2 — Finish the settings/governance vocabulary cleanup (logged 2026-09-07)

Status of the previous session, re-verified against the repo and database now:

- Module registry pruned, `lending` module registered, orphaned settings screens
  deleted, company-edit prefix fields removed — **done**.
- `governance_action_registry` now holds 15 rows: Finance (3), Lending (7 —
  `loan.approve`, `loan.disburse`, `loan.restructure`, `loan.write_off`,
  `repayment.reverse`, `reversal.loan_repayment`), Platform (`app_access.grant`),
  Spend (5). **FACT**
- `src/lib/governance/selfActionCatalogue.ts` still declares
  `module: "Finance" | "Spend"` with only 5 entries — the compile-time mirror is
  out of parity with the table, so
  `src/test/architecture/governance-action-registry-parity.test.ts` fails. **FACT**

### Remaining items, in execution order

1. **`selfActionCatalogue.ts`** — widen the `module` union to
   `"Finance" | "Spend" | "Lending" | "Platform"` and add the eight missing
   entries with the exact `action_key`/`subject_table` pairs listed above.
   Then run the parity, `sod-coverage` and `governance-single-engine` tests.
2. **`src/components/settings/BranchConfiguration.tsx`** — the override payload
   is pruned but `inheritedFromBusiness` (lines ~128-138) still reads
   `business.invoice_prefix`, `estimate_prefix`, `bill_prefix` and the POS
   `receipt_prefix`, and the `business` prop interface no longer declares them.
   Remove those four keys and their entries; keep logo, address, contact and
   `receipt_header`/`receipt_footer`. Typecheck this file specifically.
3. **Copy rewrites** (presentation only, no logic):
   - `BranchOperations.tsx` line 10 (header comment) and line 154 — replace
     "invoice prefix"/"default warehouse" with receipt text and branch document
     details.
   - `WorkspaceSettings.tsx` lines 340, 362, 378, 439 — invoices → loan
     statements and repayment receipts; line 439's "inventory from QuickBooks,
     Odoo, Xero, Tally" → client and loan data import from CSV/XLSX.
   - `AccessGroups.tsx` line 193 example "Sales / User" → "Lending / Loan
     Officer"; column tooltips 304-307 → Approve: loan applications and journal
     entries; Post: journal entries; Pay: disbursements and repayment
     settlements; Export: GL and portfolio reports.
4. **Verification** — `bunx tsgo --noEmit`, the governance/approval test suites,
   then a signed-in walk of the Company and Workspace settings tabs plus
   Settings → Governance to confirm no ERP word remains on screen.

### Still deferred (unchanged)

`reset_module__hr/pos/sales/costing` remain live behind the workspace-reset
routine; dropping them, and dropping `businesses.invoice_prefix` /
`estimate_prefix` / `bill_prefix` and `branches.invoice_prefix_suffix` /
`default_warehouse_id`, belongs to the later legacy-cleanup wave.


===============THIS WAS THE LAST MESSAGE FROM THE AGENT BEFORE ITS TIME RUN OUT=============


Here's where the governance and settings cleanup stands.

Done in this pass: the governed-action list now includes the lending actions (approve, disburse, restructure, write-off, repayment reversal), the expense workflow actions and app-access grants, with matching record pickers for loan applications, loans, repayments and access grants; the leftover ERP wording is gone from Branch Operations, Workspace Settings, Access Groups and the branch inherited-values panel (invoice/estimate/bill prefixes removed, imports reworded to client and loan data, action tooltips now describe loan approvals, postings, disbursements and portfolio exports). Type checks pass and the governance/approval tests are green.

Remaining: I wrote a new parity test file but hadn't run it yet, and the signed-in walk of the Company, Workspace and Governance settings tabs plus the self-approval refusal checks (Wave G-5) are still outstanding.
---

## Wave S-3 — Documents & communications settings vocabulary (logged 2026-09-07)

Re-verified now, so the next agent does not repeat it:

- `governance_action_registry` parity is **green**: `governance-action-registry-parity`
  and `governance-single-engine` both pass (8 tests). The catalogue/table mirror is
  no longer an open item. **FACT**
- `permission_groups` holds exactly 7 system groups — Institution Admin, Branch
  Manager, Loan Officer, Credit Analyst, Cashier / Teller, Accountant, Auditor.
  No ERP group (HR Manager, Payroll Admin, Attendance Officer, Internal User)
  remains. Access-group seeding is **done**; do not re-audit it. **FACT**
- `src/lib/permissions.ts` mentions the inherited ERP permissions only in a
  header comment; no ERP permission literals remain. **FACT**

Still ERP-shaped, all presentation/config surfaces inside Settings (evidence:
grep hits recorded below):

1. `src/types/documentTemplate.ts` — `DocumentTemplateType` is
   `invoice | estimate | proforma | credit_note | receipt | purchase_order`, with
   matching `DOCUMENT_TYPE_LABELS`. Both `document_templates` and
   `email_templates` are **empty tables**, so the type set can be narrowed with
   no data migration. Target set: `receipt` (repayment receipt),
   `statement` (client/loan statement), `schedule` (repayment schedule),
   `disbursement_voucher`. Confirm against the document engine's registered
   artifact kinds before renaming — the renderer, not this file, is authoritative.
2. `src/components/settings/DocumentTemplateSettings.tsx` — tabs and the
   `["invoice","estimate","proforma","credit_note"]` array (lines ~55, 76,
   137-167) follow whatever set (1) settles on.
3. `src/components/settings/EmailTemplateEditor.tsx` — template keys
   `invoice_sent`, `estimate_sent`, `invoice_overdue` and the
   `{{invoice_number}}` / `{{estimate_number}}` sample tokens (lines 36-120).
   Replace with `receipt_sent`, `statement_sent`, `repayment_overdue` and
   `{{receipt_number}}` / `{{loan_number}}` / `{{amount_due}}`.
4. `src/components/settings/PaymentMethodsSettings.tsx` — the `EXPECTED_TYPES`
   guard at line 121 lists eight ERP document types; the copy at 290/307 says
   "invoices, sale orders, proforma invoices". This array is a runtime guard,
   so narrow it in the same commit as (1) or the guard will reject valid rows.
5. `src/components/settings/AddPaymentMethodDialog.tsx` line 287,
   `src/components/settings/PaymentGatewaySettings.tsx` lines 111/266,
   `src/components/settings/BusinessLogoUpload.tsx` lines 8/255,
   `src/components/settings/MpesaC2BProviderCard.tsx` line 257,
   `src/pages/settings/CompanySettings.tsx` line 311,
   `src/pages/settings/UserProfilePage.tsx` line 5,
   `src/components/settings/AppAccessApprovalsInbox.tsx` line 272,
   `src/components/governance/GovernedEntityPicker.tsx` line 6 — pure copy /
   comments. Reword to receipts, statements and repayments; M-Pesa C2B matches
   to loan repayments, not invoices.

Order: (1) → (4) → (2) → (3) → (5). Typecheck after (1)+(4) together, since the
type narrowing and the guard array must land in the same step. No migration is
required in this wave.

## Wave G-5 — Verification (still outstanding, unchanged)

Signed in as `fredrickmureti612@gmail.com`: walk Company and Workspace settings
tabs plus Settings → Governance and confirm no ERP word remains on screen; then
the self-approval refusals (payment and loan approval must fail with
`GOV_SELF_ACTION` and write an `audit_logs` row), Loan Officer cannot approve or
disburse, Branch Manager cannot act on another branch's loan.

Run G-5 only after S-3, otherwise the settings walk will re-find the same wording.


===============THIS WAS THE LAST MESSAGE FROM THE AGENT BEFORE ITS TIME RUN OUT=============

Here's where things stand.

Done in this pass: document templates and email templates now speak microfinance. The template tabs are Loan Agreements, Repayment Schedules, Loan Statements, Client Statements and Repayment Receipts instead of invoices/estimates/proforma/credit notes, and the built-in emails are now Loan Approved, Loan Disbursed, Repayment Receipt, Repayment Reminder and Repayment Overdue (the old invoice/estimate emails were removed — none had been created yet, so nothing was lost). Payment methods, payment gateways, the logo panel, M‑Pesa, company email sender copy, the profile page, the access-approvals inbox and the governance record picker were all reworded to loans, repayments, receipts and statements.

Remaining, in order:
1. Three leftover placeholder strings still say "invoice": `useDocumentTemplates.ts` line 95 (default title `INVOICE`) and `DocumentTemplateBuilder.tsx` lines 91, 100, 326 — these should become loan/receipt wording.
2. A type check and a build check have not been run since these edits, so the app should be verified before anything else.

---

# Wave S-4 — Finish the settings vocabulary pass, then verify (current wave)

## Objective

Close the three items the previous pass left open, fix the one real breakage
that its type narrowing introduced, and run the outstanding Wave G-5
verification. No new architecture, no migrations, no RBAC changes.

## Findings confirmed this session (do not re-investigate)

- `DocumentTemplateType` is already narrowed to
  `loan_agreement | repayment_schedule | loan_statement | client_statement |
  loan_payment_receipt`. **FACT**
- **Breakage:** `src/types/documentTemplate.ts` line 168 still sets
  `DEFAULT_TEMPLATE.template_type: 'invoice'`, which is no longer a member of
  that union — this is a type error, not just wording. Line 180 also still sets
  `document_title_format: 'INVOICE'`. **FACT**
- `src/hooks/useDocumentTemplates.ts` line 95 still defaults
  `document_title_format` to `'INVOICE'`. **FACT**
- The builder lives at `src/components/templates/DocumentTemplateBuilder.tsx`
  (not `components/settings`); placeholders at lines 91, 100 and 326 still say
  Invoice / TAX INVOICE / "include invoice number". **FACT**
- No other ERP wording remains under `src/components/settings` or
  `src/pages/settings`. **FACT**
- Remaining `invoice`/`estimate` hits elsewhere in `src` are infrastructure that
  is **out of scope** for this wave and belongs to the later legacy-cleanup
  wave: `src/lib/queryKeys.ts`, `src/lib/payments/deriveInvoiceFromAllocations.ts`,
  `src/lib/migration/sourceSystemPresets.ts`,
  `src/contexts/BusinessContext.tsx` / `BranchContext.tsx` (`invoice_prefix`,
  `estimate_prefix`, `invoice_prefix_suffix` column mirrors),
  `src/contexts/SessionContext.tsx` (`invoices_count` usage counter),
  `src/test/architecture/support/enumStatusLiterals.ts`,
  `src/pages/reports/JournalReport.tsx` source-type label map,
  plus assorted doc comments. **FACT**

## Step 1 — Fix the type error and the default titles

| File | Change |
| --- | --- |
| `src/types/documentTemplate.ts` L168 | `template_type: 'loan_payment_receipt'` |
| `src/types/documentTemplate.ts` L180 | `document_title_format: 'REPAYMENT RECEIPT'` |
| `src/hooks/useDocumentTemplates.ts` L95 | fallback `'REPAYMENT RECEIPT'` |
| `src/components/templates/DocumentTemplateBuilder.tsx` L91 | `e.g., Standard Repayment Receipt` |
| `src/components/templates/DocumentTemplateBuilder.tsx` L100 | `e.g., REPAYMENT RECEIPT, LOAN STATEMENT` |
| `src/components/templates/DocumentTemplateBuilder.tsx` L326 | `e.g., Please quote your loan number on every repayment.` |

`document_templates` is empty, so no data migration is needed.

## Step 2 — Verify the build

`bunx tsgo --noEmit`, then read `/tmp/observability/build-errors.log` for the
post-edit build. Both must be clean before Step 3. If tsgo surfaces other
consumers of the removed template types, fix those in this same step rather
than widening the union back.

## Step 3 — Wave G-5 verification (signed in as `fredrickmureti612@gmail.com`)

Driven with Playwright against `http://localhost:8080`, session restored from
the injected preview session.

1. **Settings walk** — `/settings/company`, `/settings/workspace` and
   Settings → Governance: capture the visible text of each tab and assert none
   of `invoice`, `estimate`, `proforma`, `credit note`, `purchase order`,
   `payroll`, `attendance`, `POS` appears on screen.
2. **Self-approval refusal** — attempt a self-approval on a repayment and on a
   loan application as the creating user; both must fail with SQLSTATE `42501`
   / HINT `GOV_SELF_ACTION` and write an `audit_logs` row.
3. **Role restriction** — a Loan Officer group member can neither approve nor
   disburse a loan.
4. **Branch restriction** — a Branch Manager cannot act on a loan belonging to
   another branch.

Record each result in this file as PASS/FAIL with the evidence line.

## Acceptance criteria

- `tsgo --noEmit` clean and the build log reports `build OK`.
- No ERP vocabulary visible anywhere under Settings or Governance.
- All four G-5 checks recorded with evidence.

## Risks / rollback

Steps 1-2 are string and literal edits inside one already-narrowed type — revert
the six lines to roll back. Step 3 is read-only apart from the deliberate
refusal attempts, which are rejected transactions and leave no financial rows.

## Explicitly deferred (unchanged)

`reset_module__hr/pos/sales/costing`; dropping `businesses.invoice_prefix` /
`estimate_prefix` / `bill_prefix` and `branches.invoice_prefix_suffix` /
`default_warehouse_id`; and the infrastructure-level `invoice`/`estimate`
identifiers listed under Findings.
3. Wave G‑5 verification (signed-in walk of the Company, Workspace and Governance settings tabs, plus the self-approval refusal and role/branch restriction checks) is still outstanding.
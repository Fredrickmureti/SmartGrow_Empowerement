# ADR 0092 — Garnishment Payable ≠ PAYE Payable

Date: 2026-07-23
Status: Accepted

## Context

The Kenya (and every other supported jurisdiction's) payroll pack seeds a
`PAYE Payable` liability account for statutory income-tax withholding remitted
to the tax authority (KRA, HMRC, IRS, etc.). Separately, when a legal order
(garnishment) is created, the system auto-provisions a `Garnishment Payable`
liability account for the third party named on the order (court, child-support
agency, creditor, SACCO).

Because the English word **"payee"** (recipient of a payment) sits one letter
away from the acronym **PAYE** (Pay-As-You-Earn), users have read the garnishment
UI badge `payee unmapped` as `PAYE unmapped` and assumed the tax mapping was
broken. It was not — the badge only meant `employee_garnishments.payee_contact_id
IS NULL` (recipient stored as free text, not linked to a `contacts` row).

## Decision

1. **Two distinct liability accounts, forever.** `Garnishment Payable` and
   `PAYE Payable` are never merged, aliased, or auto-consolidated. They have
   different creditors, different remittance channels, different statutory
   reporting, and different lifecycle events. This mirrors SAP HCM
   (`Vendor for garnishment` vs. tax-authority vendor), Oracle HCM Fusion
   (`Third-Party Payment Payee` vs. statutory tax deduction), Workday
   (`Third Party Payee` vs. Tax Authority), Dynamics 365 F&O
   (`Garnishment vendor account` vs. tax settlement account) and Odoo
   (`l10n_*_deduction_partner` vs. tax partner).

2. **Recipient linkage gate.** A garnishment whose `payee_contact_id` is null
   is a **draft** for remittance purposes. Remittance batches
   (`payroll_remittance_payments`) require a linked `contacts` row so that an
   actual payment method / bank file can be produced. This is enforced by the
   `payee_unmapped` trigger (migration `20260630171823`) and by the readiness
   checks in the remittance batch page.

3. **UI copy must not collide with `PAYE`.** User-visible strings on the
   garnishment surface use **"recipient"** instead of "payee". The database
   columns keep their historical names (`payee_name`, `payee_bank`,
   `payee_account`, `payee_reference`, `payee_contact_id`, `payee_unmapped`)
   for API stability.

## Consequences

- No schema change. The trigger and columns are unchanged.
- No change to GL posting, account auto-provisioning, or remittance batching.
- Any new garnishment / legal-order UI must use "recipient" in labels, badges,
  and tooltips. When the "recipient not linked" badge is shown, its tooltip
  must explicitly state that this is unrelated to PAYE tax.

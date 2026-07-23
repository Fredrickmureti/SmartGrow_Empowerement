# Disambiguate "payee unmapped" from PAYE (tax)

## Verdict first

The garnishment subsystem is **solid and matches how SAP, Oracle HCM, Workday, Dynamics and Odoo model third-party garnishment recipients**:

- Each legal order has its **own** liability account ("Garnishment Payable"), separate from statutory liabilities like **PAYE Payable** (tax withholding to KRA). They are not the same account and must never be merged — different creditor, different remittance channel, different reporting.
- `employee_garnishments.payee_unmapped` is a trigger-computed flag meaning "the recipient of this deduction is free-text only and has **not been linked to a `contacts` row**". Until it is linked, the remittance batch flow cannot cut a real payment to that third party. This is the same gate SAP enforces with "Vendor for garnishment" and Workday with "Third Party Payee".

Nothing in the accounting or lifecycle model needs to change.

## The only real problem: wording collision with PAYE

On a payroll screen, the string **"payee unmapped"** sits inches away from **"PAYE Payable"**. That's a UX trap — the user reasonably reads it as "PAYE unmapped" and assumes the tax mapping is broken. Fix the copy, not the model.

## Changes

Presentation-only, in `src/pages/hr/payroll/Garnishments.tsx`:

1. Rename the badge from **"payee unmapped"** → **"recipient not linked"**.
2. Update the tooltip to make the meaning explicit and unambiguous:
   > "The third-party recipient (e.g. court, CSA, creditor) is stored as free text only. Link it to a Contact to enable remittance payments. This is unrelated to PAYE tax."
3. Rename the section header on the create/edit sheet from **"Payee & remittance"** → **"Recipient & remittance"** and each field label from "Payee name / bank / account / reference" → "Recipient name / bank / account / reference". Keep the DB column names (`payee_*`) as-is — API stability.
4. Add a one-line ADR note in `docs/adr/` (or append to an existing garnishment ADR if present) recording the invariant:
   *"Garnishment Payable ≠ PAYE Payable. Each legal order maps to a distinct third-party liability with its own recipient (`contacts` row)."*

## Out of scope

- No schema changes. `payee_contact_id`, `payee_unmapped`, and the trigger stay.
- No changes to remittance batching, GL posting, or account auto-provisioning.
- No changes to statutory (PAYE/NSSF/SHIF/AHL/NITA) mappings.

## Technical notes

- Column `employee_garnishments.payee_unmapped` is maintained by trigger `payee_unmapped := (payee_contact_id IS NULL)` (migration `20260630171823`). We keep that as-is; it's already correct.
- `payroll_liabilities.payee_contact_id` (migration `20260630172003`) is the join used by the remittance batch page — unchanged.
- Only the two files below are touched:
  - `src/pages/hr/payroll/Garnishments.tsx` (badge text, tooltip, section/field labels)
  - `docs/adr/xxxx-garnishment-vs-paye.md` (new short ADR, ~20 lines)

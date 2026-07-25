## What's actually happening

The toast is not a governance/approval problem — it's a missing field in the employee-facing request form.

Verified:

- `loan_types` rows in this org all have `requires_consent = true`, including **Salary Advance** (`SAL_ADV`).
- The RPC `request_employee_loan` raises exactly this error at the consent check:
  `IF v_lt.requires_consent AND NOT v_consent_ack THEN RAISE ... 'requires you to accept the payroll deduction consent before submitting'` (HINT `LOAN_POLICY_CONSENT`), reading `_input->>'consent_acknowledged'`.
- `src/hooks/useMyLoans.ts` builds the RPC payload and **never sends `consent_acknowledged` or `collateral_description`** — there's even a comment admitting they're "optional here".
- `src/components/loans/RequestLoanWizard.tsx` has no consent checkbox and no collateral field at all (zero matches for either).

So the employee can never satisfy a server-side rule the UI never asks about. Same for `requires_collateral` (currently false everywhere, but the same dead end).

The consent gate itself is correct and should stay: `employee_loans` has `consent_captured_at` / `consent_captured_by`, i.e. the deduction authorisation is meant to be recorded per request. The bug is that the UI doesn't collect it.

## Fix

Frontend only — no schema or RPC change.

1. **`RequestLoanWizard.tsx`**
   - When the selected loan type has `requires_consent`, render a required checkbox in the review section: "I authorise <Org> to deduct the agreed instalment from my salary until this <loan type> is fully repaid." Show the estimated monthly deduction next to it so the acknowledgement is informed.
   - When the selected type has `requires_collateral`, render a required "Collateral offered" textarea.
   - Include both in the existing `canSubmit` guard so the submit button stays disabled until they're satisfied (fail in the UI, not via a server 400).
   - Reset both in `reset()` and whenever the loan type changes.

2. **`useLoanTypes.ts`** — surface `requires_consent` / `requires_collateral` on the `LoanType` type and in the select list if not already selected (the settings page already toggles `requires_consent`, so the column is read somewhere; confirm the ESS query returns it).

3. **`useMyLoans.ts`**
   - Add `consent_acknowledged?: boolean` and `collateral_description?: string | null` to `MyLoanRequestInput`.
   - Pass them into the RPC payload; drop the stale "optional here" comment.

4. **Error copy** — map the RPC `HINT` codes (`LOAN_POLICY_CONSENT`, `LOAN_POLICY_COLLATERAL`, and the bound violations) to friendlier toast text in the mutation's `onError`, so a future server-side refusal reads as guidance rather than a raw Postgres message.

## Out of scope / noted

- The admin-side loan wizard uses the same RPC; I'll check it sends consent too and fix it the same way if it doesn't (HR capturing consent on the employee's behalf must still be recorded).
- Approval routing after submission is unchanged — `requires_approval` is true on all four types, so requests continue to land with HR as designed.

# Customer Ledger — Audit Verdicts and Remediation

## Business event reconstruction (from the GL, verified)

The single customer with AR activity is `54709d33…`:

- 12 posted journal lines on the AR control account, net **KES 800.00 debit**.
- One open document: invoice `00008`, dated 2026-08-10, due 2026-08-29,
  total 800.00, applied 0.00, residual 800.00, posted JE present, branch scoped,
  currency KES at rate 1.0.
- Zero unapplied credit (`finance_ar_customer_credit` has no rows).

So the answer to "what caused the balance" is: one sent, GL-posted invoice with
no payment, credit note or refund against it. Open-items and the subledger agree
exactly (800.00 = 800.00). **The financial substrate is sound.** The defects are
in the identity and read layers above it.

## Verdicts

**1. Crash — confirmed defect (identity vocabulary drift).**
`fetchLedgerSearchableCustomers` filters `contacts.contact_type`. The column does
not exist: `contacts` has `type` (enum named `contact_type`), plus `customer_rank`
and `commercial_partner_id`. The enum's *type name* was mistaken for a *column
name*. Because the index page awaits both fetches together, the whole page dies,
including the position rollup that would otherwise have rendered.

**2. Same bug, second site — confirmed.**
`BillFromTimesheetsDialog.tsx:56` filters `c.contact_type === "customer" || "both"`
in JavaScript. No crash — it silently evaluates to `undefined` for every contact,
so the customer dropdown is permanently empty. Same root cause, different symptom.
`contactImportConfig.ts` correctly targets `type` (alias only) and is fine.

**3. Duplicate AR balance engine — confirmed architectural violation.**
ADR 0029 states there is exactly one balance engine. `useCustomerOutstandingBalance`
re-derives net receivable in React with a `switch` on `doc_type`, and it is wrong
three ways:
- `case "deposit"` never fires — `customer_ledger_entries` never emits `deposit`
  (unapplied cash arrives as `payment`), so `outstandingCash` is structurally 0.
- `payment_reversal` rows are dropped entirely, so a reversed payment understates
  the receivable — the exact class of bug ADR 0012/0029 were written to kill.
- `Math.max(0, …)` clamps mask a negative (credit) position instead of surfacing it.
It feeds `useCustomerCredit`, so credit decisions ride on this shadow number.

**4. Ledger page vocabulary incomplete — confirmed.**
`CustomerLedger.tsx` has `DOC_ICON`/`DOC_LABEL` for invoice, payment, deposit,
credit_note, refund. It has no entry for `payment_reversal` or `journal`, both of
which the view emits, so those rows render with no icon and a raw code. The
statement dataset (`describeLedgerDoc`) already handles both — the page is behind
the canonical vocabulary rather than sharing it.

**5. Currency and family asymmetry vs statements — confirmed.**
`salesCustomerStatement.ts` supports `consolidate` (commercial-partner family) and
tracks `otherCurrencies`. The ledger page and hook do neither: the running balance
sums `debit − credit` across mixed transaction currencies with no guard, and a
child contact's ledger silently excludes family activity. Same customer, two
answers, depending on which surface is open.

**6. Credit replicated per branch in `finance_ar_net_position` — confirmed.**
`agg` is grained by branch; `credit` is grained by business. The LEFT JOIN repeats
the full credit balance on every branch row, so any multi-branch rollup (including
the index page's "Unapplied credit" KPI, which sums rows) over-credits. Not visible
today (one branch, zero credits) but latent and silent.

**7. Not a defect — `finance_ar_net_position` returning no rows to my query.**
The view ends with `WHERE public.is_org_member(auth.uid(), …)`. Admin SQL has a
NULL `auth.uid()`, so it correctly returns nothing. In-app the row renders.
I verified this rather than reporting a phantom bug.

## Remediation

1. **Fix the identity filter.** In `customerLedgerIndex.ts`, select customers by
   `type in ('customer','both')` OR `customer_rank > 0`, ordered by name.
2. **Fix the timesheet dialog** to filter on `type` with the same predicate.
3. **Extract one identity predicate** (`src/services/finance/customerIdentity.ts`)
   used by both, and add an architecture test banning `contact_type` as a column
   or property reference anywhere in `src/`.
4. **Retire the shadow balance engine.** Rewrite `useCustomerOutstandingBalance`
   to compute strictly `Σ(debit − credit)` over `customer_ledger_entries` (no
   doc_type switch, no clamps), exposing `netReceivable` plus a credit split
   derived from sign, so reversals and journals are counted by construction.
5. **Share the doc vocabulary.** Have `CustomerLedger.tsx` label rows through the
   canonical `describeLedgerDoc` and add `payment_reversal` / `journal` icons.
6. **Currency guard on the ledger page**: if entries span more than one currency,
   show the same warning the statement builder raises instead of adding them.
7. **Migration** fixing `finance_ar_net_position` so credit is attributed once —
   grain credit to branch where known and attribute unbranched credit to a single
   row per contact, never replicated.

## Technical notes

- Files: `src/services/finance/customerLedgerIndex.ts`,
  `src/pages/sales/CustomerLedgerIndex.tsx`, `src/pages/sales/CustomerLedger.tsx`,
  `src/hooks/useCustomerOutstandingBalance.ts`,
  `src/components/timesheets/BillFromTimesheetsDialog.tsx`, new
  `src/services/finance/customerIdentity.ts`, one new migration.
- No edge-function redeploy needed: statement rendering is untouched.
- Tests: identity-predicate ban, and a hook test asserting a `payment_reversal`
  row moves the receivable.

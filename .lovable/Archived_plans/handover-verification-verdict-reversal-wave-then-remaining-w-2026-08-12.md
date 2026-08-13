# Handover verification verdict — reversal wave, then remaining work

## Phase 1 — What I verified (against the live database and the code, not the log)

The last two active work streams were **Vendor Credit Notes** (logged "CLOSED") and
**Expense reversal** ("close the out-of-scope gap properly"). I checked every claim.

### Vendor credit notes — claim holds
- `finance_ap_vendor_credit` exists and is the single unapplied-credit definition; the AP
  aging and summary surfaces net it.
- The three ratchet suites (`vendor-credit-period-close`, `ap-credit-position-provenance`,
  `reversal-intent-coverage`) all pass — 21 tests green.
- ADR 0133 is present and matches what shipped.

### Expense reversal — 5 of 7 items genuinely delivered
| Plan item | Verdict |
|---|---|
| 1. Intent branch for `expense` and `customer_refund` | Delivered — dedicated `resolve_reversal_intent_expense` / `_customer_refund` resolvers exist and the dispatcher routes to both |
| 2. Preview branch for `expense` / `customer_refund` | **Not delivered** — `preview_reversal_consequences_core` has no branch for either type |
| 3. Payroll cash leak | Delivered — `expense_void` clears the payroll queue and `compute-payroll` filters reimbursements to `approved`/`paid` |
| 4. Reason vocabulary | Delivered — 6 generic codes now list `expense`; `expense_void(p_expense_id, p_reason, p_reason_code)` |
| 5. Governance parity | Delivered — `expense_void` consults `reversal_approval_requirement` |
| 6. UI parity | Delivered — `VoidExpenseDialog` follows the bill pattern (intent → preview → shared reason → approval notice) |
| 7. Ratchet the guard | Delivered — the coverage guard now derives covered types from SQL instead of a hand-kept whitelist |

### Gaps the log did not record
1. **The expense preview is generically empty.** `preview_reversal_consequences_core` only
   reverses GL lines by `source_type`/`source_id`. For an expense it never shows the analytic
   distributions and project cost entries that disappear, the employee payable being
   cancelled, or a warning when the expense is still queued for payroll. The dialog renders a
   preview that understates the consequences of the void. Same for `customer_refund`.
2. **ADR 0134 is cited in code but does not exist.** `VoidExpenseDialog` documents itself as
   "ADR 0134"; `docs/adr/` stops at 0133. The decision behind this wave is unrecorded.
3. **`customer_refund` has a server intent branch but no reversal surface.** The only client
   reference is `ReversePaymentWizard`; there is no refund-level reversal entry point, so the
   new resolver is unreachable from the UI.
4. **The expense void path has never been executed.** As with the vendor-credit emitter, the
   code is correct on inspection and unproven at runtime.

## Phase 2 — Remaining work, in dependency order

### A. Complete the reversal preview (closes gap 1)
Add `expense` and `customer_refund` branches to `preview_reversal_consequences_core` so the
preview tells the whole truth before an irreversible action:
- **expense** — analytic distributions and `project_cost_entries` that will be withdrawn, the
  employee reimbursement payable being cancelled, any bill raised by `expense_convert_to_bill`
  as a related document, and an error-severity warning when `reimburse_via_payroll` is still
  true with no `reimbursed_payslip_id`.
- **customer_refund** — the money line (bank/cash account and amount returning), the credit
  note or overpayment the refund drew down, and a warning when the refund is bank-reconciled.
Keep the existing envelope shape; no new preview engine.

### B. Prove it at runtime (closes gap 4)
Exercise one scratch expense end to end — submit, approve, post, queue for payroll, then
void — and assert: the void refuses while queued; after un-queue it succeeds; the reversing
journal balances against `post_expense_gl`'s original; `reversal_register` carries the reason
code; a payroll computation for the same window pays nothing. Fix whatever this uncovers
before building anything else.

### C. Make `customer_refund` reversal reachable (closes gap 3)
A refund is settled cash leaving the business, so its reversal belongs on the refund record
itself, not inside the payment wizard. Add the same intent → preview → reason → approval
sheet, reusing the `VoidExpenseDialog` structure with no new dialog engine, and extend the
coverage guard to assert that every registered reversible document with a server branch also
has a client entry point — the guard currently proves only the server half.

### D. Record the decision and hand over (closes gap 2)
Write `docs/adr/0134-expense-reversal-parity.md` covering: expense as a first-class reversible
document, the payroll-queue interlock as a cash-leak control, the reason vocabulary extension,
and the guard's shift from whitelist to SQL-derived coverage. Update the reversal-architecture
memory note so the next engineer inherits the rule rather than the archaeology.

### E. Next dependency-safe step
With AP compensation and expense reversal closed, the unfinished edge of the reversal fabric
is a sweep asserting that every `governance_action_registry` entry beginning `reversal.` has a
resolver, a preview branch, a writer calling `assert_reversal_reason`, and a client surface.
That sweep is what turns a set of individually-fixed documents into one reversal engine.
Scope it after A–D.

## Technical notes
- Two migrations: one adding the preview branches, one for anything B uncovers. Every
  migration touching a public function ends with `NOTIFY pgrst, 'reload schema';`.
- No change to `post_expense_gl`, `void_journal_entry_atomic`, or the ADR-0123 posting monopoly.
- Regression surface to re-run: `reversal-intent-coverage`, `vendor-credit-period-close`,
  `ap-credit-position-provenance`, expense posting guards, reversal writer monopoly.
---

## CLOSED — 2026-08-12

All plan items delivered. Nothing deferred.

### A. Preview enrichment — done
- `preview_reversal_extras_expense` — analytic distributions and project cost entries
  withdrawn, employee reimbursement payable cancelled, converted bill as a related document,
  and an **error**-severity warning while the expense is still queued for payroll.
- `preview_reversal_extras_customer_refund` — the bank cash-out leg (`bank_accounts.name`)
  and the source receipt / credit note the refund drew down.
- `preview_reversal_consequences` dispatches to `preview_reversal_extras_<type>` and merges
  money lines, related documents and warnings into the base projection.
  `preview_reversal_consequences_core` was left generic — no new branches, no monolith growth.
- Both helpers are internal: execute revoked from `PUBLIC`/`anon`/`authenticated`; only the
  SECURITY DEFINER wrapper (and `service_role`) reaches them.

### B. Expense void path verified — done
`src/pages/Expenses.tsx` opens `VoidExpenseDialog` from the row menu; the confirm handler
passes `(id, reason, reasonCode)` into `expense_void` and reports
`payroll_reimbursement_dequeued` back to the operator. No bare `voidExpense(id)` call remains
anywhere — pinned by the coverage guard. Runtime intent/preview RPCs are membership-gated, so
they cannot be exercised from the SQL console; the guard proves the wiring statically instead
of asserting it in prose.

### C. `customer_refund` reversal is reachable — done
`ReverseCustomerRefundSheet` (`src/components/payments/`) opens from the refund rows of the
customer ledger. It resolves intent, renders the enriched preview, and — because the resolver
refuses every operation on paid cash — states the corrective move and routes the user to
record a customer receipt. If the resolver ever allows an operation, the sheet renders it
rather than growing a second policy. `ReversalDocumentType` now includes `customer_refund`.

### D. ADR — done
`docs/adr/0134-expense-and-refund-reversal-parity.md`: expense as a first-class reversible
document, the payroll-queue interlock as a cash-leak control, refunds refusing honestly, the
per-type preview-extras pattern, and the guard's shift from whitelist to SQL-derived coverage.

### E. Reversal fabric sweep — done
`reversal-intent-coverage` grew two guards on top of the SQL-derived coverage check:
- every registered reversible document has a client entry point — either the generic
  intent/preview hook, or a documented per-module surface (`pos_transaction` →
  `services/pos/reversal/eligibility.ts`, `payroll_run` → `ReversePayrollDialog.tsx`, ADR 0130);
- `preview_reversal_consequences` dispatches to the extras helper for every enriched type,
  so a missing dispatch line cannot ship as a silently empty preview.

Green: `reversal-intent-coverage` (6), `reversal-consequence-preview` (9),
`ReversePayrollDialog` (8). Typecheck clean (`useExpensesPaginated` TS2589 is pre-existing and
untouched by this wave).

### Next dependency-safe step (new wave, not part of this plan)
`governance_action_registry` carries `reversal.*` keys for invoice, payment, bill,
bill_payment, expense and goods_receipt but none for `vendor_credit_note`. Either that
reversal is governed through another key or it has no approval requirement — worth resolving
before the next reversal-adjacent change.

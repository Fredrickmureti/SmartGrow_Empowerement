# Business Reversal & Compensation Architecture — Audit Verdict and Convergence Plan

## Verdict in one line

A canonical reversal architecture **does exist and is largely correct** for the financial
core; it is **broken at its single most important line of code**, and it is **incomplete
at the domain edges** (purchases, warehouse, bank reconciliation) where reversal was
never given an owner. This is not a collection of competing reversal engines — it is one
engine with an untested chokepoint and unfinished participants.

---

## 1. Root cause of the reported failure

`public.void_journal_entry_atomic` mirrors each line of the entry being reversed:

```
INSERT INTO public.journal_entry_lines (
  journal_entry_id, account_id, description,
  debit, credit, contact_id, sort_order, business_id, branch_id)
```

`organization_id` appears in neither the column list nor the values. The column is
`NOT NULL`, and the `BEFORE INSERT` trigger `_jel_enforce_org_match` **validates** the
value against the parent entry instead of backfilling it — producing exactly the reported
message `journal_entry_lines.organization_id (<NULL>) must match parent ...`.

Confirmed against the live database:

- `journal_entry_lines.organization_id` is `NOT NULL`; no default, no backfill trigger.
- The sibling writer `post_journal_entry_atomic` **does** stamp all three scope columns —
  it was repaired during the multi-tenant hardening pass; the reversal writer was not.
- Only three functions in the entire database insert journal lines
  (`post_journal_entry_atomic`, `update_journal_entry_atomic`, `void_journal_entry_atomic`),
  so the posting monopoly of ADR 0123 is intact. That is why one omission breaks everything.
- Zero journal lines with a null `organization_id` exist: the constraint is refusing the
  bad write rather than corrupting the ledger.

### The significant finding is not the omission

`void_journal_entry_atomic` is the terminal writer for **every** reversal in the platform:
invoice void (revenue leg and COGS leg), payment void, bill and bill-payment void, manual
journal void, and payroll run reversal. It has been broken since the multi-tenant hardening
migration. Therefore **no reversal of any kind has been executed successfully in this
system since that date, in any module**, and nothing detected it. The gap is not the line —
it is that reversal has no end-to-end test on any path, in a platform that has 18 numbered
ADRs about how reversal should behave.

---

## 2. What the audit found (engineering report)

### Reversal implementations discovered

| Domain | Entry points | Ownership verdict |
|---|---|---|
| Sales — invoices | `void_invoice_atomic` → `void_journal_entry_atomic`, `void_payment_atomic`, `restore_invoice_stock_atomic` | Correct: one server-side saga, idempotent, period-guarded (ADR 0127) |
| AR — payments | `void_payment_atomic`, `unapply_payment_atomic`, `refund_customer_atomic`, `issue_credit_note_for_payment_atomic`, `apply_customer_deposit_atomic` | Correct: intent-modelled, reason-coded, wizard-gated (ADR 0012/0125) |
| AP — bills | `void_bill_payment_atomic`; bill void calls `void_journal_entry_atomic` directly from `useBills.ts` | Partial drift: bill void has no `void_bill_atomic` sibling to `void_invoice_atomic` |
| Purchases — PO/GRN | `cancel_purchase_order`, `reverse_landed_cost_bill`; three-way-match reversal RPC never built | Gap: no ADR, no engine, no ratchet |
| POS | `pos_reversal_workflow_*` saga, `pos_card_reverse`, `_pos_reverse_transaction_gl` | Deliberately separate saga (correct for retail), but posts GL through its own path, not the shared reversal writer |
| Inventory | `reverse_stock_adjustment_atomic`, `reverse_stock_movement`, `physical_count_cancel` | Correct pattern (offsetting rows, never in-place edit — ADR 0016) |
| Warehouse/WMS | `cancel_pick_wave`, `_wms_unwind_cancelled_wave`, `cancel_delivery_atomic`, `cancel_stock_transfer_atomic`, `wms_reverse_billable_activity`, ~10 more | Gap: bespoke per-operation unwinds, no shared contract outside `wms_transition_return` |
| Payroll | `payroll_reverse_run_atomic`, correction-delta engine, `payroll_batch_reverse` | Correct: corrections are additive deltas, never voids (ADR 0045); GL leg delegates to the shared writer |
| Loans / advances | `employee_loan_cancel`, `employee_loan_reverse_repayment`, advance recovery | Correct: single-writer, ratcheted (ADR 0091/0124) |
| Bank reconciliation | Un-matching handled only through the AR unapply reason taxonomy | Gap: no ADR, no reversal engine, no ratchet |

### Participation analysis

- **Finance:** owns posting exclusively; the monopoly is genuinely enforced (verified in
  the live catalogue, not just asserted by the ADR). Period locks, balance checks and
  `accounting_events` emission all sit behind the engine.
- **Inventory:** participates through `restore_invoice_stock_atomic` and offsetting
  movement rows; valuation layers (`cost_layers`, `cost_layer_consumptions`) are
  maintained by trigger, so reversal cost impact is derived, not recomputed by callers.
- **Warehouse:** does **not** participate in financial reversal at all. Voiding an invoice
  whose delivery note has open warehouse tasks leaves those tasks live.
- **POS:** correctly modelled as command + compensation saga with manager override,
  reason taxonomy and idempotent resume — the most mature reversal surface in the codebase.
- **Payroll:** correctly refuses the "void" metaphor.
- **Security/governance:** reason codes, self-approval guards, period locks and role
  checks exist per-RPC. There is no single reversal authorization policy — each engine
  re-implements its own gate.
- **Audit:** `payment_reversal_events` is append-only with a single writer; POS emits to
  `business_event_outbox`. Warehouse and purchase cancellations emit nothing comparable.

### Does a canonical engine exist?

Yes for **posting** (`post_journal_entry_atomic` / `void_journal_entry_atomic`).
No for **orchestration**: each document type carries its own saga. That is the correct
enterprise shape — SAP, Oracle and NetSuite all separate the reversal *document* from the
reversal *posting*. The defect is not too many engines; it is that three domains never got
a saga at all, and that the shared posting leg has no test.

### Enterprise comparison — the paid invoice question

Every mature ERP refuses to void a settled or period-closed invoice. SAP requires a
cancellation document (VF11) and blocks it once cleared; Oracle and NetSuite force a credit
memo; Dynamics 365 posts a corrective/reversing document; Odoo forces a credit note once
posted. None of them cascade-unwinds a customer payment as a side effect of voiding an
invoice. This platform's `void_invoice_atomic` will cascade-void live payments when asked —
that is a stronger, more dangerous power than any of the reference systems grant, and it is
the behaviour that has to change.

---

## 3. Target architecture

```text
                 UI: Reversal Intent Workspace (consequence preview)
                                   |
                     Reversal Intent Resolver (policy)
        decides: void | credit note | refund | customer credit | correction
                                   |
        Document-owned reversal saga (one per document type)
   invoice / bill / payment / POS sale / payroll run / stock document
                                   |
        +--------------+-----------+-----------+--------------+
        | Finance      | Inventory | Warehouse | Audit/Events |
        | posting      | movement  | task      | outbox       |
        | engine       | engine    | unwind    |              |
        +--------------+-----------+-----------+--------------+
```

Principles the target enforces: the saga knows sequence and compensation, never accounting
or stock rules; every participant is idempotent by `client_request_id`; nothing deletes
history; policy decides *which* reversal is legal before the UI offers a button.

---

## 4. Phased plan

### Phase 0 — Restore reversal (blocking, ships first)

- Migration: stamp `organization_id` in the reversal-line insert inside
  `void_journal_entry_atomic`.
- Harden the class, not the instance: make `_jel_enforce_org_match` backfill a NULL
  `organization_id`/`business_id` from the parent entry before validating, so no future
  writer can reintroduce this failure.
- Add `supabase/tests/journal_reversal_test.sql` proving a multi-line entry reverses with
  correct scope columns, and an end-to-end paid-invoice void test covering revenue leg,
  COGS leg and the payment cascade — the test that was missing.

### Phase 1 — Reversal intent policy (paid-invoice correctness)

- New `resolve_reversal_intent(document, id)` returning the legal operations for a
  document given its settlement state, period status and reconciliation state.
- `void_invoice_atomic` refuses when the invoice has live payments, is bank-reconciled, or
  sits in a closed period; those cases resolve to credit note, refund or customer credit.
  `_cascade_payments` is retired as an operator-facing option.
- UI: `VoidInvoiceDialog` becomes a reversal intent step that names the resolved operation
  and its consequences before executing.

### Phase 2 — Consequence preview

- `preview_reversal(document, id)` returns, for the resolved intent: journal entries to be
  reversed, GL accounts touched, receivable/payable delta, payments affected, stock to be
  returned, warehouse tasks impacted, period and tax implications.
- One shared `ReversalConsequencePanel` consumed by the invoice, bill, payment, POS and
  payroll reversal surfaces. No module writes its own consequence copy.

### Phase 3 — Close the AP and purchases gap

- `void_bill_atomic` as the AP sibling of `void_invoice_atomic`; the direct
  `void_journal_entry_atomic` call in `useBills.ts` is removed.
- Build the deferred three-way-match / GRN reversal RPC: GRNI unwind, landed-cost
  reversal, matched-quantity release.
- ADR + architecture ratchet for both.

### Phase 4 — Warehouse and bank reconciliation participation

- A `reversal_participants` contract: invoice/delivery reversal unwinds open warehouse
  tasks and reservations through the WMS transition RPC instead of leaving them live.
- `unreconcile_bank_match_atomic` as the single un-matching writer, with reason code and
  period guard; ADR + ratchet.

### Phase 5 — Unified governance and audit

- One reversal authorization policy (role, approval threshold, mandatory reason) applied by
  every saga instead of per-RPC gates.
- Every reversal emits to `business_event_outbox` using the POS event vocabulary, extended
  to finance and inventory topics.
- A single ADR superseding the reversal fragments, plus one ratchet asserting every
  reversal RPC is `SECURITY DEFINER`, period-guarded, idempotent and non-deleting.

Each phase is independently shippable and leaves the system green. No legacy reversal path
is kept alongside a new one — Phase 3 and 4 delete the code they replace.

---

## Technical notes

- Phase 0 is a database migration plus SQL tests; no application code changes.
- No existing ledger data needs repair: the constraint blocked the bad write, so there are
  no journal lines with a null `organization_id` to backfill.
- `payroll_reverse_run_atomic`, bill void and manual journal void all start working again
  the moment Phase 0 lands, since they share the repaired writer.
- POS keeps its own saga engine; it is the reference implementation the other domains
  converge toward, not a duplicate to be removed.

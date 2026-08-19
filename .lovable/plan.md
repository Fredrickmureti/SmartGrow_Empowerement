# Reconciliation Engine — Execution Plan

## Objective

A bank line is an observation, not an accounting event. The engine must identify
which existing accounting event explains it, settle it through the authoritative
engines (payment/posting/FX), refuse when evidence is insufficient, and be
reversible without divergence. Today it does the opposite in several places: it
*mints* accounting events to make lines disappear.

## Verified Architecture (facts, established from DB + code this turn)

- Matching seam exists and is the only writer for the invoice/bill/account path:
  `bank_match_propose` → `bank_match_confirm` → `bank_match_reject` /
  `bank_match_reverse`, all SECURITY DEFINER, `search_path=public`, permission-gated
  by `assert_can_reconcile_bank`, period-gated by `is_period_open` (ADR 0144).
- `bank_match_confirm` delegates settlement to `record_multi_invoice_payment` /
  `record_multi_bill_payment` and posts only through `post_journal_entry_atomic`.
  The journal monopoly (ADR 0123) holds here.
- FX: one resolver, `require_exchange_rate`, called at txn date; refuses on absence.
- Allocation vocabulary is closed to three kinds, enforced in `_bank_match_validate`:
  `invoice`, `bill`, `account`. Mixed kinds rejected. Cross-business rejected.
- Parallel, non-seam writers exist: `reconcile_bank_transfer_atomic`,
  `unreconcile_bank_transaction`, `bank_transaction_set_category`,
  `apply_reconciliation_rules` (auto-post), `bank_reconciliation_session_*`.
- UI: `ReconcileTransactionSheet` (Invoices / Bills / Expenses / Manual tabs),
  `TransferReconcileSheet`, `BankFeeds`, `BankReconciliation`,
  `useBankTransactions.reconcileTransaction`, `useReconciliationSuggestions`.
- `bank_transactions` has `reconciled_payment_id` and `lifecycle_status`, and
  `unreconcile_bank_transaction` already branches on `reconciled_type IN
  ('payment','bill_payment')` — but no writer can ever produce those values.

## Critical Findings

### F1 — Matching an invoice mints a second payment (the Undeposited Funds case)
- Evidence: `bank_match_confirm`, kind `invoice`, unconditionally calls
  `record_multi_invoice_payment(...)`. No lookup of an existing `payments` row
  already sitting in a clearing/undeposited account for that invoice/customer/amount.
  `_bank_match_validate` only allows `invoice|bill|account`.
- Impact: the standard flow (payment recorded → Dr Undeposited Funds / Cr AR →
  deposit appears on statement) produces a **duplicate receipt**: AR is credited
  twice, undeposited funds never clear, customer balance and AR control are wrong.
- Required change: add resolution kinds `payment` and `bill_payment` that *settle
  an existing payment into the bank* (Dr Bank / Cr clearing account of that payment)
  instead of creating one. Candidate generation must prefer an existing payment over
  a document whenever one exists.
- Dependencies: clearing-account resolution (`clearing_undeposited_funds`,
  `clearing_pos`, `credit_card_clearing` via `_resolve_canonical_default_account`);
  the payment's actual debit account must be read from its journal, not guessed.
- Validation: E2E `payment-in-undeposited-funds → deposit` scenario; assert exactly
  one payment row, AR credited once, clearing account nets to zero.

### F2 — Bank fee is double-counted and is silently taken out of the customer's debt
- Evidence: `_bank_match_validate` requires `allocations + fee = |txn|`;
  `bank_match_confirm` then settles `_net = |txn| - fee` **and** posts a second JE
  crediting bank for the fee again.
- Impact: for a 100,000 invoice received as 98,500 with a 1,500 fee, bank moves
  95,500 (should be 98,500) and the invoice is left 3,000 short. Bank GL diverges
  from the statement on every fee match.
- Required change: allocations must sum to the **gross document settlement**; the
  fee is the difference between gross and the bank line, posted Dr Fee / Cr AR-side
  only via the settlement engine's own fee handling or a single balanced JE. Bank
  must move exactly `|txn|`, once.
- Validation: pgTAP asserting bank GL delta = `|txn|` for every fee match, and
  document settled at gross.

### F3 — Unreconcile leaves the ledger and the document out of step
- Evidence: `unreconcile_bank_transaction` voids `bank_transactions.journal_entry_id`
  and sets `payments.status='unreconciled'`, but never calls `void_payment_atomic` /
  `unreconcile_payment_atomic`; allocations and `invoices.amount_paid` are untouched.
- Impact: after undo, the GL is reversed while the invoice still shows paid — the
  exact anti-pattern ADR 0125 bans. Also bypasses the period guard on the void date.
- Required change: unreconcile becomes a seam that delegates per resolution kind —
  `void_payment_atomic` / `void_bill_payment_atomic` for engine-created settlements,
  a compensating reclassification for undeposited-funds clearing, `void_journal_
  entry_atomic` only for the classified-movement kind. Never a status flip.
- Validation: void-then-assert invoice `amount_paid` recomputed from live allocations.

### F4 — The suggestion engine is dead and tenant-unsafe
- Evidence: `get_reconciliation_match_suggestions` selects
  `bt2.matched_journal_entry_id`; that column does not exist on `bank_transactions`
  (37 columns verified). Its ACL grants EXECUTE to **anon**, and it filters by the
  `_org_id`/`_business_id` passed in without any membership assertion.
- Impact: every call raises at runtime, so `useReconciliationSuggestions` never
  returns anything; and the function is a cross-tenant read primitive.
- Required change: replace with a candidate/evidence engine (see Matching Model),
  revoke `anon`, assert membership via the same gate as the seam.

### F5 — Suggestions and resolutions are disjoint vocabularies
- Evidence: suggestions return `journal_entry_id`/`line_id`; the seam accepts only
  `invoice|bill|account` allocations. There is no path to action a suggestion.
- Required change: candidates must be emitted in the same resolution vocabulary the
  seam consumes, with an evidence payload the UI can render.

### F6 — Rules can post over accounting truth
- Evidence: `apply_reconciliation_rules` matches on description/reference/amount
  only, then `bank_match_propose(document_type:'account')` and, when `auto_post`,
  immediately `bank_match_confirm`. No check for an existing payment or open document.
- Impact: a receipt that settles an invoice can be auto-posted to a rule's expense
  account; AR is never cleared and the line looks reconciled.
- Required change: rules produce candidates only. Auto-post is permitted only for
  deterministic classes (see Safety Model) and is refused whenever a document- or
  payment-class candidate exists for the same line.

### F7 — Aggregate and partial reality is not modelled
- Evidence: `_bank_match_validate` forces allocations + fee = `|txn|`;
  `ReconcileTransactionSheet.handleReconcile` loops `onReconcile` once **per selected
  invoice**, each consuming the whole line — the second call fails
  `BANK_MATCH_ALREADY_RECONCILED`.
- Impact: three payments in one deposit, and one payment across two bank lines,
  are both impossible. Users are pushed to the Manual tab, which is F6's hazard.
- Required change: one propose call carrying N allocations (already supported
  server-side); allow a bank line to be *partially* explained with an explicit named
  residual, and allow one document to be settled by several lines.

### F8 — Isolation is business-level only
- Evidence: `_bank_match_validate` compares `business_id` and nothing else; branch
  and document currency are never compared with the bank account.
- Impact: a branch-restricted document can be settled from another branch's bank
  line; a foreign-currency invoice can be matched to a base-currency line with a
  rate applied to the wrong side.
- Required change: assert branch compatibility and document/bank currency
  compatibility in the validator; refuse rather than convert.

### F9 — Multiple reconciliation writers
- Evidence: `reconcile_bank_transfer_atomic` and `unreconcile_bank_transaction`
  write reconciled state outside the four-seam contract of ADR 0144.
- Required change: transfer becomes a resolution kind on the seam; unreconcile
  becomes `bank_match_reverse`'s delegate. Ratchet the seam list.

## Accounting Invariants (must never be violated)

1. A bank line never creates a payment when an existing payment explains it.
2. The bank GL moves by exactly the bank line amount, exactly once, per confirmation.
3. Documents are settled gross; differences are *named* (fee, FX, write-off) or the
   match is refused.
4. Journals only via `post_journal_entry_atomic`; settlements only via
   `record_multi_invoice_payment` / `record_multi_bill_payment` /
   `record_advance_payment` / `record_vendor_advance_payment`.
5. Reconciliation state is a consequence of a posting, never a flag.
6. Undo reverses through the accounting reversal model; nothing is deleted or flipped.
7. Cross-business, cross-branch and cross-currency matches are refused, never coerced.
8. Ambiguity produces no posting.
9. A locked period refuses on both confirm and reverse.

## Resolution Model (authoritative kinds)

| Kind | Meaning | Accounting effect |
|---|---|---|
| `payment` | existing customer receipt clears into bank | Dr Bank / Cr that payment's clearing account |
| `bill_payment` | existing supplier payment clears | Cr Bank / Dr clearing |
| `invoice` | receipt not yet recorded | `record_multi_invoice_payment` |
| `bill` | supplier payment not yet recorded | `record_multi_bill_payment` |
| `customer_advance` / `vendor_advance` | unallocated receipt/payment | existing advance RPCs |
| `transfer` | movement between own accounts | paired line, no P&L |
| `account` | classified movement (fee, interest, charge) | balanced JE via engine |
| `fee` / `fx_difference` / `writeoff` | named residual on another kind | never standalone silent |
| `unresolved` | no posting | state only |
| `statement_info` | non-posting statement metadata | state only |

## Matching Model

Candidates are generated per line from: existing unreconciled payments/bill payments
in clearing accounts, open invoices/bills, other accounts' mirror lines (transfers),
and rules. Each candidate carries an evidence vector — amount (exact / within named
residual), currency, date and value-date proximity, counterparty, reference and
external transaction id, bank description tokens, direction, prior accepted matches
for the same counterparty/description. Confidence tiers are derived from evidence
classes, not a score threshold: **deterministic** (external id or exact
amount+counterparty+reference on an existing payment), **suggested**, **ambiguous**
(≥2 candidates of equal class), **unresolved**, **contradictory**. Text similarity
may only *generate* a candidate; it can never raise it to deterministic.

## Safety Model

- Idempotency: propose is upsert-per-line; confirm takes a deterministic
  `client_request_id` (`brecon:<txn>`) and the posting engine dedupes on
  `(source_type, source_id)`.
- Concurrency: `FOR UPDATE` on the line and the match (already present) plus a
  partial unique index guaranteeing at most one non-reversed confirmed match per
  bank transaction.
- Isolation: business + branch + currency asserted server-side in the validator;
  `anon` EXECUTE revoked from every reconciliation function.
- Periods: `is_period_open` on confirm and on reverse.
- Audit: reuse `audit_logs` / `accounting_events`; persist the evidence payload and
  the chosen kind on the match row so any decision is explainable after the fact.
- Auto-post: deterministic tier only, never when a document/payment candidate is in
  play, never for FX or fee-bearing lines.

## Existing Logic To Reuse

`post_journal_entry_atomic`, `void_journal_entry_atomic`,
`record_multi_invoice_payment`, `record_multi_bill_payment`,
`record_advance_payment`, `record_vendor_advance_payment`,
`void_payment_atomic`, `void_bill_payment_atomic`, `unreconcile_payment_atomic`,
`require_exchange_rate`, `_resolve_canonical_default_account`,
`assert_can_reconcile_bank`, `is_period_open`, `bank_reconciliation_session_*`.

## Existing Logic To Consolidate

- `reconcile_bank_transfer_atomic` → `transfer` kind on the seam.
- `unreconcile_bank_transaction` → delegate of `bank_match_reverse`.
- `get_reconciliation_match_suggestions` → replaced by the candidate engine.
- `apply_reconciliation_rules` → candidate producer, not a poster.
- `ReconcileTransactionSheet` per-document loop → single multi-allocation call.

## Required Changes (ordered)

1. Extend `_bank_match_validate`: new kinds, branch + currency assertions, gross
   settlement + named residual arithmetic.
2. Fix the fee model in `bank_match_confirm` (F2) and add the `payment` /
   `bill_payment` clearing resolutions (F1).
3. Rewrite `unreconcile_bank_transaction` as a kind-aware reversal delegate (F3).
4. New `bank_match_candidates(_txn_id)` evidence engine; drop/replace the broken
   suggestions RPC and revoke `anon` (F4, F5).
5. Fold transfer into the seam; add the single-confirmed-match unique index (F9).
6. Subordinate rules to candidates; restrict `auto_post` to the deterministic tier (F6).
7. Client: one multi-allocation propose/confirm, evidence-led review UI showing the
   proposed accounting effect before execution, residual named explicitly (F7).
8. Ratchets: seam monopoly test extended to the new writers; ban client-side
   reconciled-state writes and per-document loops.
9. ADR amending 0144 with the resolution vocabulary and the clearing rule.

## Validation

pgTAP: undeposited-funds clearing; direct receipt; fee line (bank delta == line);
partial; aggregate 3→1; split 1→3; overpayment→advance; transfer vs receipt;
FX with and without a rate; duplicate import; double confirm; concurrent confirm;
locked period; wrong business; wrong branch; wrong currency; already reconciled;
reverse restores `amount_paid` from live allocations.
Vitest architecture: seam monopoly, no client reconciled-state writes, no second
suggestion engine. Regression: AR/AP payment, void, session complete, bank balance
derivation, control-account reconciliation reports.

## Execution Status

- [ ] 1 validator extension
- [ ] 2 fee model + clearing resolutions
- [ ] 3 reversal delegate
- [ ] 4 candidate/evidence engine
- [ ] 5 transfer into seam + uniqueness
- [ ] 6 rules subordinated
- [ ] 7 client workspace
- [ ] 8 ratchets
- [ ] 9 ADR

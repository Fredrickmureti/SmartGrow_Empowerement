# Business Reversal & Compensation Convergence

Authoritative status. Update after every implementation.

## Verification verdict (independent audit, 2026-08-07)

Every Phase 0–2 claim from the previous engineer was checked directly against
the database and the codebase. Findings:

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Phase 0 — reversal writer stamps scope columns | Confirmed | `void_journal_entry_atomic` exists as a single overload; `supabase/tests/journal_reversal_scope_test.sql` present; memory core rule recorded |
| Phase 1 — intent policy in the database | Confirmed | `resolve_reversal_intent(text, uuid)` and `payment_is_bank_reconciled(uuid)` exist and are STABLE; `void_invoice_atomic` still exposes `_cascade_payments` but the hook no longer passes it |
| Phase 1 — client consumes the policy, no client-side credit-note/cascade logic | Confirmed | `useTransactionReversal.resolveReversalIntent`; `VoidInvoiceDialog` renders blockers and only allowed operations |
| Phase 1 — guard tests | Confirmed present | `src/test/architecture/reversal-intent-policy.test.ts` (suite could not be executed in this environment — vitest deps are not installed here; verification was by reading the assertions) |
| Phase 2 backend — `preview_reversal_consequences` | Confirmed | function exists, STABLE, returns `{intent, gl{entries,entry_count,total_reversed}, stock{lines}, money{lines}, related_documents[], warnings[]}`; invoice and payment branches implemented |
| Phase 2 frontend — hook, component, dialog mounting, guard test | **Not done** | zero references to `previewReversalConsequences` anywhere in `src/`; `src/components/reversal/` does not exist |

Conclusion: no architectural drift or superficial patching found in what was
shipped; the backend is genuinely ahead of the UI. Resume at Phase 2 frontend.
Nothing needs to be rolled back.

## Phase 0 — Restore reversal capability — DONE, VERIFIED
## Phase 1 — Reversal intent policy — DONE, VERIFIED
(Details unchanged; see verification table above.)

## Phase 2 — Consequence preview — backend DONE, frontend NEXT

Work to execute now, in order:

1. `previewReversalConsequences(documentType, documentId)` in
   `src/hooks/useTransactionReversal.ts` — thin RPC wrapper, typed
   `ReversalConsequences` mirroring the function's JSON contract exactly. No
   client-side re-derivation of GL, stock or settlement figures.
2. `src/components/reversal/ReversalConsequencePreview.tsx` — one presentational
   component, no data fetching of its own, four sections:
   - **Accounting** — per journal entry (main / COGS), account code + name and
     the mirrored debit/credit, plus total reversed.
   - **Inventory** — products, warehouse, quantity returning to stock; explicit
     "nothing returns to stock" empty state.
   - **Money** — for an invoice: the live payments and whether each is bank
     reconciled; for a payment: each invoice's balance before/after.
   - **Consequences & warnings** — severity-ordered (`error`, `warning`,
     `info`) with related-document counts (delivery notes, credit notes,
     fiscal receipt).
   Copy states what *will* change and what *will not* — no raw SQL terms.
3. Mount it in `VoidInvoiceDialog.tsx` (below the resolved intent, above the
   reason field) and in `ReversePaymentWizard.tsx` on the confirmation step.
   Confirm buttons stay disabled while the preview is loading or errored, so no
   reversal is ever authorised blind.
4. Architecture guard `src/test/architecture/reversal-consequence-preview.test.ts`
   — every reversal confirmation surface must import
   `ReversalConsequencePreview`, and the preview component must not call
   `supabase` directly.

## Phase 3 — Purchases / AP / GRN participation — NOT STARTED
- `resolve_reversal_intent` and `preview_reversal_consequences` gain `bill`,
  `bill_payment` and `goods_receipt` branches (settled / matched / received /
  period-closed blockers; recommended operation = vendor credit note or GRN
  return).
- `void_bill_atomic` — the gap named in `mem://features/business-reversal-architecture`:
  reverse the bill JE, unwind three-way-match state, refuse when a payment or a
  goods receipt is attached, never delete.
- Wire the same intent + preview UI into the bill and bill-payment void surfaces.
- Ratchets extending `journal-posting-monopoly.test.ts` for the new writer.

## Phase 4 — Warehouse tasks & bank reconciliation participation — NOT STARTED
- Reversal must cancel open pick/pack/delivery tasks for a voided document
  instead of leaving them live; task cancellation is owned by the warehouse
  domain and invoked as a participant, not reimplemented in the reversal path.
- Bank reconciliation un-matching engine (`unmatch_bank_transaction_atomic`) so
  the `bank_reconciled` blocker has a legal resolution path instead of a dead
  end.
- Preview gains a warehouse section and a reconciliation section.

## Phase 5 — Unified governance, audit outbox, ADR consolidation — NOT STARTED
- One reversal authorization policy (`can_reverse(document_type, id, actor)`)
  replacing the per-RPC ad-hoc gates; mandatory reason codes everywhere.
- Reversal events onto the existing business event outbox so audit, analytics
  and notifications subscribe instead of each writer notifying.
- Retire `_cascade_payments` from `void_invoice_atomic`'s signature once no
  caller passes it, and fold ADRs 0125/0126/0127 into one reversal ADR that
  names the intent policy, the preview contract and the participant model.

## Phase 6 (new, appended by this audit) — Payroll & POS convergence — NOT STARTED
- Payroll does not void: it corrects. Confirm `payroll_reverse_*` surfaces
  resolve through the intent policy (adjustment run vs recovery run vs
  reversal) rather than exposing a raw reversal button.
- POS (`src/services/pos/reversal/*`) is the most mature surface and is the
  reference implementation, not a duplicate. Task here is to make POS *consume*
  the shared intent policy and preview contract while keeping its saga, so the
  two models stop evolving independently.

## Instructions for the next agent
1. Verify before building; the table above records what is already proven.
2. Execute Phase 2 items 1–4 end-to-end before touching Phase 3.
3. Keep every reversal routed through the canonical writers, the intent policy
   and the preview contract. Never reintroduce client-side compensation logic.

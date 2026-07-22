# POS Refund/Reversal — Execution Plan

Investigation is complete (see previous turn's verdicts). This is the execution plan. No fix-the-toast patches. Each stage lands behind a feature flag, ships with tests, and does not remove old behaviour until the replacement is verified.

Supabase: proceeding against the currently-linked project (`jkszmrroyjfdwokbkzis`). If `AccrualFlowCorporation` is a different project, swap it in the Cloud panel before Stage 4 (finance/GL work) — Stages 1–3 are code-only and project-agnostic.

## Root defects (from audit, evidence in previous message)

- F1 — No `TerminalSessionEnvelope`; 25+ duplicated `!companyId` guards; five call sites drop `businessId`.
- F2 — Void / Card-Auth-Reversal / Refund / Return / Exchange / Store-Credit collapsed into one "Reverse" button; 4 overlapping implementations.
- F3 — `pos_override_matrix` + `assert_manager_override` exist but `pos_card_reverse` never calls them; PIN is client-side theatre.
- F4 — Reversal path does not touch inventory, GL, tax, receipt, audit, or outbox despite comments claiming otherwise.
- F5 — No offline capability on PIN verify or reversal RPC.
- F6 — Two parallel financial reversal models produce divergent state.

## Stage 1 — TerminalSessionEnvelope (kills F1 permanently)

New module `src/services/pos/session/TerminalSessionEnvelope.ts`:

```text
TerminalSessionEnvelope = {
  organizationId, businessId, storeId, warehouseId,
  registerId, shiftId, cashierId,
  currency, taxProfile, pricingProfile, hardwareProfile,
  openedAt, envelopeVersion
}
```

- `TerminalSessionProvider` React context, populated once at shift-open, immutable for the shift.
- `useTerminalSession()` hook + `assertActiveTerminalSession(envelope, action)` guard.
- Mutation hooks (`useManagerOverride`, `usePOSVoid`, `usePOSReturns`, `usePOSHeldTransactions`, `usePOSShifts`, `usePOSTransactionHistory`, card terminal controller) accept the envelope, not loose IDs.
- Delete the 25+ local `!companyId` guards; one canonical guard remains.
- ESLint rule `no-loose-org-business-id-in-pos` forbids new `useX(orgId, businessId)`-style hooks in `src/apps/pos/**` and `src/services/pos/**`.
- Codemod migrates the five broken call sites (`CardPaymentActions.tsx:76`, `HistoryWorkspace.tsx:122`, `CartItemEditor.tsx:57`, `CashDrawerDialog.tsx:71`, `DiscountDialog.tsx:55`) plus the correct-but-loose ones.

Exit criteria: "Company not selected" cannot be thrown from any POS call site; unit test covers each migrated hook; contract test forbids re-introduction.

## Stage 2 — Domain event taxonomy (kills F2)

New domain module `src/services/pos/reversal/`:

```text
commands/
  VoidSaleCommand          (same-shift, pre-settlement, no goods movement)
  ReverseCardAuthorization (settlement-state flip, tender-only)
  RefundSaleCommand        (money out, whole or partial)
  ReturnGoodsCommand       (goods back + disposition)
  ExchangeCommand          (return + new sale, atomic)
  IssueStoreCreditCommand
events/
  pos.sale.voided
  pos.card.reversed
  pos.sale.refunded
  pos.goods.returned
  pos.sale.exchanged
  pos.store_credit.issued
reasonCodes/  (canonical enum, shared with existing PaymentReversalReason)
```

- Reason codes unified with Path 4's existing `PaymentReversalReason`.
- History screen replaces the single "Reverse" button with an action menu whose items map 1:1 to commands, gated by policy (Stage 3) and eligibility (item state / receipt age / tender type).
- Existing `pos_card_reverse` becomes the implementation of `ReverseCardAuthorization` only; RPC name preserved for backward compat, semantics narrowed.

## Stage 3 — Policy-driven authorization (kills F3)

- Every command RPC calls `assert_manager_override(...)` server-side. PIN dialog becomes an approval-capture UI, not a gate.
- New view `pos_override_matrix_effective` resolves the applicable policy per `{command, amount, tender, receipt_age, category, role, store}`.
- Client asks the matrix "is approval required for this command with these facts?" — if no, no PIN dialog; if yes, PIN dialog → `pos_manager_overrides` insert → RPC references the override id, and `assert_manager_override` enforces it.
- Replace blanket "Override denied" toast with reason-specific copy driven by RPC error codes (`override_expired`, `wrong_role`, `threshold_exceeded`, `invalid_pin`, `wrong_business`).

## Stage 4 — Refund saga (kills F4 and F6)

New service `src/services/pos/reversal/RefundSaga.ts` orchestrates:

```text
payment reversal (Path-4 code, reused, not duplicated)
   → inventory return-to-stock (stock_movements, stock_quants, cost_layers)
   → warehouse disposition (sellable | inspection | damaged | quarantine | vendor_return)
   → reversing journal (void_journal_entry_atomic, existing)
   → tax/fiscal notification (etims_transmission_logs, fiscal_transmissions)
   → receipt artifact (document_artifacts, print_jobs)
   → audit (commercial_audit_logs, payment_reversal_events)
   → outbox (business_event_outbox event per Stage 2 vocabulary)
```

- Saga is transactional at the DB layer where possible (single migration RPC `pos_refund_execute`), with compensating actions for external legs (fiscal/print).
- Path 1's ad-hoc `pos_card_reverse` mutation stays only as the tender leg invoked by the saga.
- `useTransactionReversal` (Path 4) becomes the payment leg of this saga — one implementation, called from both the POS terminal and `ReversePaymentWizard`.

## Stage 5 — Offline resilience (kills F5)

- Shift-open mints a short-TTL signed manager-credential bundle (list of managers + hashed PINs + policy snapshot) stored in the envelope.
- PIN verification runs locally against that bundle when offline; the override + command are queued to `business_event_outbox` and replayed on reconnect with idempotency keys.
- `ConnectivityManager` gates whether the saga executes online (immediate) or defers legs that require the network (fiscal, print server).

## Stage 6 — Consolidation & deprecation

- Delete duplicate void hooks and any code superseded by the saga.
- Freeze `pos_card_reverse` as an internal RPC callable only by the saga.
- Contract test forbids new direct callers of low-level reversal RPCs from feature code.

## Sequencing & rollout

```text
Stage 1  →  Stage 2  →  Stage 3  →  Stage 4  →  Stage 5  →  Stage 6
   |          |          |           |           |           |
   flag       flag       flag        flag        flag       cleanup
```

Each stage:
1. Migration (where needed) with GRANTs and RLS.
2. Code + feature flag.
3. Vitest unit + `src/test/architecture/` contract test + integration test.
4. Verify against a real POS reverse flow.
5. Move to next stage only when the previous stage's flag is on for real traffic and no regressions surface.

## First implementation slice on approval

**Stage 1 in full** (session envelope + 5 broken call sites + ESLint rule + contract test) — this alone eliminates the "Company not selected" bug class and unlocks Stages 2–5 without further schema churn. I will start there and stop for review before opening Stage 2.

## Explicit non-goals

- Do NOT add `businessId` as a second argument to `useManagerOverride` as a spot fix. That was the shortcut; it is rejected in favour of the envelope.
- Do NOT introduce a parallel event bus. Reuse `business_event_outbox`.
- Do NOT touch `auth.users`, reserved schemas, or `service_role` in client code.
- Do NOT edit `supabase/migrations/` files by hand — migrations go through the migration tool.

Approve this plan and I will begin Stage 1 immediately upon build-mode switch, and stop for review before Stage 2.

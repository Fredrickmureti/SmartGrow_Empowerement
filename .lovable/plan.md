# POS Refund/Reversal — Execution Plan (Living Document)

Investigation complete. Execution in progress. Each stage lands behind a
seam, ships with tests, and does not remove old behaviour until the
replacement is verified end-to-end.

Supabase: proceeding against the currently-linked project (`jkszmrroyjfdwokbkzis`).
If `AccrualFlowCorporation` is a different project, swap it in the Cloud
panel BEFORE Stage 4 (finance/GL work). Stages 1–3 are code-only and
project-agnostic.

---

## Status board

| Stage | Title                         | State        | Verified by                                                        |
| ----- | ----------------------------- | ------------ | ------------------------------------------------------------------ |
| 1     | TerminalSessionEnvelope       | ✅ COMPLETE  | `src/test/architecture/terminal-session-envelope.test.ts` (5/5)    |
| 2     | Domain event taxonomy         | ✅ COMPLETE  | `src/test/architecture/pos-reversal-taxonomy.test.ts` (7/7)        |
| 3     | Policy-driven authorization   | ⏭ NEXT       | (pending)                                                          |
| 4     | Refund saga                   | ⏳ PENDING    | (pending)                                                          |
| 5     | Offline resilience            | ⏳ PENDING    | (pending)                                                          |
| 6     | Consolidation & deprecation   | ⏳ PENDING    | (pending)                                                          |

**Currently active phase:** Stage 2 just landed. Next agent begins Stage 3.

---

## Root defects (from the audit — never edit, this is the reference)

- **F1** — No `TerminalSessionEnvelope`; 25+ duplicated `!companyId`
  guards; five call sites drop `businessId`.
- **F2** — Void / Card-Auth-Reversal / Refund / Return / Exchange /
  Store-Credit collapsed into one "Reverse" button; four overlapping
  implementations.
- **F3** — `pos_override_matrix` + `assert_manager_override` exist but
  `pos_card_reverse` never calls them; PIN is client-side theatre.
- **F4** — Reversal path does not touch inventory, GL, tax, receipt,
  audit, or outbox despite comments claiming otherwise.
- **F5** — No offline capability on PIN verify or reversal RPC.
- **F6** — Two parallel financial reversal models produce divergent state.

---

## Stage 1 — TerminalSessionEnvelope ✅ COMPLETE (kills F1)

**Delivered:**

- `src/services/pos/session/TerminalSessionEnvelope.ts` — envelope type,
  `useTerminalSessionEnvelope`, `assertActiveTerminalSession`,
  `mergeEnvelope`, `TerminalSessionMissingFieldError`,
  `describeMissingField`.
- `src/hooks/pos/useManagerOverride.ts` — refactored to accept
  `Partial<TerminalSessionEnvelope>` only. Legacy positional signature
  removed. Distinguishes envelope-hydration errors ("Terminal not ready")
  from real authorization failures ("Override Denied").
- **All 8 call sites migrated** to the envelope-object shape:
  - `src/components/pos/transaction-detail/CardPaymentActions.tsx`
  - `src/apps/pos/terminal/history/HistoryWorkspace.tsx`
  - `src/components/pos/CartItemEditor.tsx`
  - `src/components/pos/DiscountDialog.tsx`
  - `src/components/pos/CashDrawerDialog.tsx`
  - `src/components/pos/RescueSessionAlert.tsx` (envelope override for rescue)
  - `src/components/pos/ReopenShiftDialog.tsx` (envelope override for rescue)
  - `src/apps/pos/terminal/return/ReturnWorkspace.tsx`
- **ESLint rule** `local/no-loose-manager-override-args` at
  `eslint-rules/no-loose-manager-override-args.js`, registered in
  `eslint.config.js` at `error`.
- **Contract test** `src/test/architecture/terminal-session-envelope.test.ts`
  (5/5 passing) — enforces the loose-arg ban, envelope signature, and
  presence of the historical error-literal purge.

**Exit criteria met:** "Company not selected" cannot originate from any
POS call site of `useManagerOverride`; ESLint + contract test prevent
regression.

---

## Stage 2 — Domain event taxonomy ✅ COMPLETE (kills F2)

**Delivered — `src/services/pos/reversal/`:**

- `reasonCodes.ts` — the canonical `POSReversalReasonCode` union
  (superset of ADR-0012 `PaymentReversalReason`), `REASON_METADATA`,
  `getReasonsForCommand`, `assertReasonAllowedForCommand`,
  `toAccountingReason` (exhaustive mapping to the finance leg).
- `events.ts` — `POS_REVERSAL_EVENT_TOPICS` (`pos.sale.voided`,
  `pos.card.reversed`, `pos.sale.refunded`, `pos.goods.returned`,
  `pos.sale.exchanged`, `pos.store_credit.issued`) and the strict
  `POSReversalEventPayload` shape for `business_event_outbox`.
- `commands.ts` — discriminated union
  `POSReversalCommand = VoidSaleCommand | ReverseCardAuthorizationCommand
  | RefundSaleCommand | ReturnGoodsCommand | ExchangeCommand
  | IssueStoreCreditCommand`, each carrying an `ActiveTerminalSession`
  envelope + `clientRequestId` + `reasonCode` + `managerOverrideId`.
  Type guards `isVoidSale`, `isRefundSale`, … for exhaustive dispatch.
- `eligibility.ts` — pure `evaluateEligibility(facts) →
  EligibilityResult[]` and `eligibleCommands(facts)`. Encodes the
  audit's business rules (same-shift void, auth-only card reversal,
  settled-tender refund, returnable-line return/exchange, identified-
  customer store credit).
- `index.ts` — barrel export. Import from `@/services/pos/reversal`.
- **Contract test** `src/test/architecture/pos-reversal-taxonomy.test.ts`
  (7/7 passing) — pins the command union to exactly six members,
  guarantees every command has an outbox topic and ≥ 1 reason code,
  proves no orphan reasons, proves ADR-0012 codes are a strict subset,
  proves reason/command mismatches throw, proves the finance mapping is
  exhaustive.

**Exit criteria met:** commands are now first-class data objects; the
saga in Stage 4 will pattern-match on `command.type` with compiler-
enforced exhaustiveness. Reason vocabulary unified with ADR-0012 — no
fork.

**Not yet done (intentional — belongs with Stage 3):** the History
screen still shows a single "Reverse" button. Splitting it into an
action menu requires the Stage-3 policy matrix so eligible commands can
be gated per role/threshold. Do NOT split the menu without Stage 3, or
you will re-create F3.

---

## Stage 3 — Policy-driven authorization ⏭ NEXT (kills F3)

**Objective:** every reversal command RPC calls `assert_manager_override(...)`
server-side. Client-side PIN dialog becomes an approval-capture UI,
not a gate.

**Plan of record:**

1. **Server** — audit every RPC that currently mutates POS state without
   calling `assert_manager_override`. Add the call, wired to the
   `manager_override_id` on the command envelope. `pos_card_reverse` is
   the known offender; expect siblings.
2. **View** — create `pos_override_matrix_effective` that resolves the
   applicable policy per `{command, amount, tender, receipt_age,
   category, role, store}` given the six-command taxonomy from Stage 2.
   Migration + GRANTs + RLS in the same file.
3. **Client hook** — `useOverridePolicy(command, facts)` asks the
   matrix "is approval required?"; if not, no PIN dialog; if yes,
   dialog → `pos_manager_overrides` insert → command dispatched with
   `managerOverrideId` populated.
4. **Error copy** — replace the blanket "Override denied" toast with
   reason-specific copy driven by RPC error codes: `override_expired`,
   `wrong_role`, `threshold_exceeded`, `invalid_pin`, `wrong_business`.
5. **UI seam** — with the policy hook available, split the History
   "Reverse" button into the action menu whose items map 1:1 to the
   six commands from Stage 2, gated by `evaluateEligibility` +
   `useOverridePolicy`.
6. **Contract test** at `src/test/architecture/pos-override-policy.test.ts`:
   every command's dispatch path calls `assert_manager_override` when
   the matrix says approval is required; no direct RPC caller from
   feature code.

**Exit criteria for Stage 3:** every reversal command with a
policy-mandated approval step provably fails at the RPC layer when the
override is missing or forged. Blanket "Override denied" replaced with
five specific reason strings. History screen shows the six-command
action menu (dispatch is still Stage-4 saga; for Stage 3 each menu item
routes to its existing implementation).

---

## Stage 4 — Refund saga ⏳ PENDING (kills F4 and F6)

Orchestrator at `src/services/pos/reversal/RefundSaga.ts`:

```text
payment reversal (ADR-0012 path, reused, not duplicated)
   → inventory return-to-stock (stock_movements, stock_quants, cost_layers)
   → warehouse disposition (sellable | inspection | damaged | quarantine | vendor_return)
   → reversing journal (void_journal_entry_atomic, existing)
   → tax/fiscal notification (etims_transmission_logs, fiscal_transmissions)
   → receipt artifact (document_artifacts, print_jobs)
   → audit (commercial_audit_logs, payment_reversal_events)
   → outbox (business_event_outbox event per Stage 2 topics)
```

- Transactional at the DB layer via a single RPC `pos_refund_execute`;
  compensating actions for network legs (fiscal/print).
- `pos_card_reverse` becomes the tender leg only, invoked by the saga.
- `useTransactionReversal` (Path 4) becomes the payment leg — one
  implementation, called from POS terminal AND `ReversePaymentWizard`.

---

## Stage 5 — Offline resilience ⏳ PENDING (kills F5)

- Shift-open mints a short-TTL signed manager-credential bundle
  (managers + hashed PINs + policy snapshot) stored in the envelope.
- Offline PIN verification runs locally against that bundle; override +
  command queued to `business_event_outbox` and replayed on reconnect
  with `clientRequestId` as the idempotency key.
- `ConnectivityManager` gates whether the saga runs online (immediate)
  or defers network legs.

---

## Stage 6 — Consolidation & deprecation ⏳ PENDING

- Delete duplicate void hooks superseded by the saga.
- Freeze `pos_card_reverse` as an internal RPC callable only by the saga.
- Contract test forbids new direct callers of low-level reversal RPCs
  from feature code.

---

## Handoff instructions for the next agent

**Do NOT skip verification.** Before writing any Stage-3 code:

1. **Re-run both contract tests:**
   ```
   bunx vitest run src/test/architecture/terminal-session-envelope.test.ts src/test/architecture/pos-reversal-taxonomy.test.ts
   ```
   Both must be green (5/5 and 7/7). If either fails, STOP and repair —
   Stage 3 depends on both invariants holding.

2. **Sanity-check the taxonomy is actually consumed nowhere yet.** The
   plan requires the History action menu split to land WITH Stage 3, not
   before. Confirm no PR has jumped ahead and split the button without
   the policy hook — that would recreate F3.
   ```
   rg -n "eligibleCommands|evaluateEligibility|POS_REVERSAL_EVENT_TOPICS" src/
   ```
   Expected: matches only in `src/services/pos/reversal/` and
   `src/test/architecture/`. Any hit under `src/apps/pos/` or
   `src/components/pos/` before Stage 3 lands is a scope violation —
   revert it and continue.

3. **Do NOT edit `supabase/migrations/` by hand.** Use the migration tool
   when Stage 3 needs `pos_override_matrix_effective`. Follow the
   GRANT + RLS ordering from `<supabase-db>` — table create, GRANT,
   ENABLE RLS, CREATE POLICY.

4. **Do NOT reintroduce loose scalar IDs.** The Stage-1 ESLint rule and
   contract test will bounce you, but be aware that hooks OTHER than
   `useManagerOverride` still take loose IDs today (out of Stage-1
   scope). If Stage 3 needs to touch one of them, either extend the
   envelope contract to that hook FIRST or leave it alone.

5. **Start Stage 3 at step 1** ("audit every RPC that mutates POS state
   without `assert_manager_override`"). That inventory drives every
   subsequent step and cannot be shortcut.

6. **Update THIS file** (`.lovable/plan.md`) as Stage 3 progresses.
   Move the status row from ⏭ NEXT → 🚧 IN PROGRESS → ✅ COMPLETE and
   record the contract-test path that verifies the stage.

---

## Explicit non-goals (still in force)

- Do NOT add `businessId` as a second argument to any hook as a spot fix.
  The envelope replaces the loose-argument contract.
- Do NOT introduce a parallel event bus. Reuse `business_event_outbox`
  with the Stage-2 topic vocabulary.
- Do NOT touch `auth.users`, reserved schemas, or `service_role` in
  client code.
- Do NOT edit `supabase/migrations/` files by hand — migrations go
  through the migration tool.

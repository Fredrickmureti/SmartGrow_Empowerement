
# Tender Workspace — Audit & Redesign Plan

## 1. Audit verdict against POS best practice

Reference model: Square, Toast, Lightspeed, Erply, Enerpize all converge on the same tender contract:

- One **active tender draft** at a time (method + amount).
- One **input surface** (keypad) that mutates only that draft.
- A **passive summary rail** that reflects the authoritative payment session (Net Payable, Paid, Remaining, Change, Confirm).
- Terminal state advances on **explicit business events**: `tender.draft.amountChanged`, `tender.recorded`, `tender.reversed`, `payment.confirmed`.

Current `src/apps/pos/terminal/tender/TenderWorkspace.tsx` breaks every one of those rules:

| # | Symptom you observed | Root cause in code | Verdict |
|---|---|---|---|
| 1 | Amount typed on keypad shows **below** the keypad, not in the right "Paid" area | `NumericKeypad` at line 709 is bound to local `cashTendered` state, which is a **cash-quick-pay draft only**. The right rail reads `session.allocated` (recorded tenders). They are two different variables. | Fails "single source of truth". |
| 2 | Left column scrolls | Whole left pane wrapped in `<ScrollArea>` (line 532) and stacks: MPesa row, Credit, Card, Tip, "Quick Cash Payment" (quick amounts + input + Pay-Cash button + keypad + change banner), separator, split-tender chip bar, amount input, method chips. Vertical bloat forces scroll. | Fails "no-scroll cashier surface". Big systems fit tender in one viewport. |
| 3 | Confirm does nothing | `handleSplitPayment` (line 366) requires `payments.length > 0 && totalApplied >= effectiveTotal` (`canConfirm`, line 504). Typing on the keypad never calls `recordTender`, so `payments` stays `[]` and Confirm is disabled forever unless the cashier hits the separate green "Pay Cash" button first. | Fails "Confirm = terminal event". Right now Confirm is a *finalize-already-recorded-tenders* button, misnamed. |
| 4 | Two competing "pay" affordances (keypad + green "Pay Cash" button, and later Confirm) | Cash-quick-pay flow (`handleQuickCashPayment`) and split flow (`handleAddPayment` + `handleSplitPayment`) are two separate state machines rendered simultaneously. | Fails "one active tender draft". |
| 5 | Aesthetic mismatch with Enerpize reference | Right rail is present but decorative — it doesn't participate in the input loop. | Fails "rail = authoritative projection". |

Overall verdict: **the surface is not event-driven, it is form-driven with two competing forms**. The keypad, the "Pay Cash" button, and the split-tender chip bar are three UIs racing over the same business event (`record a tender`). That is why it "looks like a joke": the cashier's inputs don't produce the state changes the layout implies they should.

## 2. Target contract (Enerpize-style, event-driven)

Business events, unchanged from `usePaymentSession`:

```text
selectMethod(method)         → sets active tender draft.method
amendDraftAmount(n)          → sets active tender draft.amount (keypad, quick chips, %-tip all funnel here)
commitDraft()                → session.recordTender(draft) → tender row persisted
reverseTender(id)            → session.reverseTender
confirmPayment()             → require remaining<=0 → onComplete(payments)
back()                       → onBack()
```

The workspace becomes a projection of `{ draft, session }`. Nothing else.

Layout (fits one 1280×800 viewport, no scrolling on left pane):

```text
┌───────── Header: Back · "Payment" · Amount Due ─────────┐
│                                                          │
│  LEFT (flex-1, no scroll)          RIGHT RAIL (w-96)     │
│  ┌────────────────────────────┐   ┌────────────────────┐│
│  │ Method tiles               │   │ POS Client         ││
│  │ (Cash · Card · M-Pesa ·    │   │ Walk-in customer   ││
│  │  Store credit · Bank …)    │   ├────────────────────┤│
│  ├────────────────────────────┤   │ Subtotal           ││
│  │ Active-draft amount        │   │ Discount           ││
│  │  KES 0.00  ← reflects draft│   │ Tax                ││
│  ├────────────────────────────┤   │ Net Payable  BOLD  ││
│  │ Quick chips: exact/+50/+100│   ├────────────────────┤│
│  ├────────────────────────────┤   │ Paid               ││
│  │ Keypad (1-9, 0, ., ⌫, C)   │   │ Remaining / Change ││
│  │ writes to draft.amount     │   ├────────────────────┤│
│  ├────────────────────────────┤   │ Recorded tenders … ││
│  │ [Add tender]  (commits     │   ├────────────────────┤│
│  │  draft, resets amount to   │   │ [ Confirm Payment ]││
│  │  next remaining)           │   │  disabled until    ││
│  └────────────────────────────┘   │  remaining<=0      ││
│                                    └────────────────────┘│
└──────────────────────────────────────────────────────────┘
```

Only three interactive things on the left: **method row**, **keypad+chips (both mutate `draft.amount`)**, **Add-tender**. Right rail is read-only except for Confirm.

## 3. Implementation steps

Scope: `src/apps/pos/terminal/tender/TenderWorkspace.tsx` only, plus a small extraction for the keypad wiring. No changes to `usePaymentSession`, RPCs, or reducer contract — those already model the events correctly; the UI just wasn't using them.

1. **Introduce a single draft state**
   ```ts
   const [draft, setDraft] = useState<{ methodKey: string; amount: string }>({
     methodKey: "",
     amount: "",
   });
   ```
   Retire `cashTendered`, `amount`, `selectedMethod`, `reference` as separate ambient states — keep `reference` inside `draft` when the selected method requires it.

2. **Method row = single component**
   Replace the three stacked colored MPesa/Credit/Card "quick-pay" blocks *and* the split chip bar with one horizontal method row (icons + names). Selecting a method sets `draft.methodKey` and pre-fills `draft.amount = remaining`. Quick-pay behaviour is preserved as "one-click": if remaining pre-fills the draft, cashier just presses Add-tender.

3. **Keypad + quick chips both write to `draft.amount`**
   `<NumericKeypad value={draft.amount} onChange={(v) => setDraft(d => ({...d, amount: v}))} … />`
   Quick chips (exact, next 10/50/100) call the same setter. Because the right rail reads `draft.amount` for a "would-pay preview" and `session.allocated` for actual Paid, the number the cashier types is visible on the right *immediately* (as "Draft") — killing symptom #1.

4. **`Add tender` button = single commit event**
   - Validates method-specific rules (reference required, customer required for store credit, min tendered ≥ amount for cash).
   - For device-mediated methods (M-Pesa STK, card terminal), opens the existing sub-modal with `draft.amount`. On success, `recordTender` runs.
   - For non-mediated methods (cash, credit_liability, bank transfer), calls `recordTender` directly.
   - On success: clear `draft.amount`, keep `draft.methodKey`, refocus keypad.

5. **Confirm button becomes the terminal event**
   - Enabled when `session.remaining <= 0`.
   - If cash-only single tender with `tendered_amount >= amount`, allow Confirm to *both* record and finalize in one press (single-tender fast path — this is what "Pay Cash" was trying to be). Implement by having Confirm auto-commit any pending draft first, then `onComplete`.
   - Fixes symptom #3 and #4 together: Confirm is now the only thing that closes the sale, whether via fast path or split.

6. **Remove `<ScrollArea>` from the left pane**
   Left pane becomes `flex flex-col min-h-0` and each row is fixed-height. Method row `h-14`, draft display `h-16`, quick chips `h-10`, keypad grid `flex-1` (natural 4x4), Add-tender `h-14`. Total fits in ~640px vertical — no scroll on any register-class screen.
   Keep MPesa/Card sub-modals as-is (they wrap driver conversations, correctly modal).

7. **Right rail: authoritative projection only**
   Preserve current `TransactionSummaryRail`, but add one row above "Paid":
   `Draft (Cash) — KES 500.00` in muted foreground when `draft.amount > 0`, so the number the cashier is typing has an explicit home on the right — which is what your Enerpize reference shows.
   Confirm button label and enable-rule updated per step 5.

8. **Delete dead branches**
   Remove the `payments.length === 0` "Quick Cash Payment" section (lines 671–733) — its role is absorbed by the unified draft+keypad+Add-tender path. Remove `canSplitPayment` gating on the method chip bar; multiple methods are always shown when configured, single-method registers just render one chip.

9. **Escape / back / esc-key** untouched. All persistence still through `usePaymentSession` — no new RPCs, no schema changes.

## 4. Event-driven checklist (post-change)

- [ ] `draft.amount` is the *only* thing keypad and quick chips mutate.
- [ ] Right rail's "Paid / Remaining / Change" reads *only* `session.allocated / remaining / change`.
- [ ] `session.recordTender` is called from exactly one place (Add-tender handler, including the fast path inside Confirm).
- [ ] `onComplete` is called from exactly one place (Confirm handler).
- [ ] No local state duplicates a value present on `session`.
- [ ] Left pane has no vertical scroll at ≥720px height.

## 5. Out of scope for this change

- Payment session RPCs, idempotency contract, saga wiring — already correct.
- Card / M-Pesa driver modals — correct to remain modal.
- Receipt phase, held-sale phase — separate workspaces, not touched.
- Visual theming beyond adopting the two-pane layout; tokens stay on existing shadcn/tailwind semantics.

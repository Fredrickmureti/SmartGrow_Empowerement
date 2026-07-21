# POS Workstation — State Machine

Date: 2026-07-21
Status: Accepted
Related: `docs/audit/2026-07-21-pos-terminal-architecture.md`, ADR-0014.

## 1. Why a state machine

An enterprise POS is defined by the invariant that **only one business
phase is live per terminal at a time**. The current implementation
tracks phase with a dozen sibling `useState` booleans in
`POSTerminal.tsx`, which allows nonsense composite states
(`showPayment && showReturn`, `showReceipt && showLock`) and leaves no
single source of truth for "what workspace should the operator see".

This document is the source of truth. Every workspace, every sheet,
every guard test refers back to it.

## 2. Phases

```text
                     ┌──────────┐
                     │  IDLE    │  shift closed / cashier locked
                     └────┬─────┘
             open shift   │
             ▼
      ┌──────────┐    add line     ┌──────────┐
      │  READY   │───────────────▶ │  SALE    │
      └────┬─────┘                 └────┬─────┘
           │                            │ commit tender
           │                            ▼
           │                       ┌──────────┐
           │                       │ TENDER   │
           │                       └────┬─────┘
           │                            │ sale.paid
           │                            ▼
           │                       ┌──────────┐
           │  new sale             │ RECEIPT  │
           └───────────────────────┴──────────┘

  side-transitions from READY / SALE:
    RETURN, HELD, HISTORY

  overlay from any phase (excluding IDLE):
    LOCKED  (manager override / cashier lock)
```

Legal phases: `idle | ready | sale | tender | receipt | return | held | history | locked`.

`locked` is an overlay — it remembers the previous phase so unlock
returns the operator to exactly where they left off.

## 3. Transitions

| From | Trigger | To |
|---|---|---|
| `idle` | `shift.opened` | `ready` |
| `ready` | `sale.line.added` (cart non-empty) | `sale` |
| `ready` | operator: Return | `return` |
| `ready` | operator: Held | `held` |
| `ready` | operator: History | `history` |
| `sale` | `sale.tender.opened` | `tender` |
| `sale` | `sale.cleared` | `ready` |
| `sale` | operator: Hold | `ready` (with hold recorded) |
| `tender` | `sale.paid` | `receipt` |
| `tender` | operator: Back | `sale` |
| `receipt` | operator: New Sale | `ready` |
| `return`, `held`, `history` | operator: Close | previous non-side phase |
| any (≠ `idle`) | manager-lock / auto-lock | `locked` (previous phase remembered) |
| `locked` | unlock | previous phase |
| `ready` / `sale` | `shift.closed` | `idle` |

**Rule:** every transition either fires from a **committed business
event** (subscription to `domainEventBus`) or a **guarded operator
intent** dispatched to the reducer. A UI click that does not translate
to one of those two channels is illegal.

## 4. Sheets vs Workspaces

A **workspace** is a route and represents the current phase.
A **sheet** is a `role="dialog"` slide-in bound to the current phase;
navigating away or transitioning phases dismisses every open sheet.

Sheets permitted per phase:

| Phase | Line-scoped sheets | Sale-scoped sheets |
|---|---|---|
| `ready` | — | `CustomerAssignSheet`, `ManagerOverrideSheet` |
| `sale`  | `LineDiscountSheet`, `LineUnitSheet`, `LineModifierSheet`, `LineOverrideSheet` | `CustomerAssignSheet`, `LoyaltyRedeemSheet`, `AgeVerifySheet`, `HoldSaleSheet`, `BillSplitSheet`, `TableTransferSheet`, `ManagerOverrideSheet` |
| `tender` | — | `ManagerOverrideSheet` |
| `receipt` | — | `SendDocumentSheet` |
| `return` | `LineOverrideSheet` | `ManagerOverrideSheet` |
| `held`, `history` | — | `ManagerOverrideSheet` |
| `locked` | — | (unlock sheet only) |

Anything else is a **workspace** and requires a route push. `PaymentDialog`, `ReceiptPreviewDialog`, `ReturnDialog`, `HeldTransactionsDialog`, `TransactionHistoryDialog` are the phase-change dialogs currently mis-classified — they become workspaces in Phases 2–3.

## 5. Reducer contract

```ts
type TerminalPhase =
  | 'idle' | 'ready' | 'sale' | 'tender'
  | 'receipt' | 'return' | 'held' | 'history' | 'locked';

interface TerminalState {
  phase: TerminalPhase;
  previousPhase: TerminalPhase | null; // for 'locked' unlock
  activeSheet: SheetId | null;
  splitPortionToPay: SplitBillPortion | null;
  tipAmount: number;
  paymentSessionIdempotencyKey: string;
  completedTransaction: CompletedTransaction | null;
}

type TerminalIntent =
  // committed business events (from domainEventBus)
  | { kind: 'event'; event: DomainEvent }
  // operator intents (from UI)
  | { kind: 'op'; op: 'openTender' | 'backToSale' | 'newSale'
        | 'openReturn' | 'openHeld' | 'openHistory' | 'closeSide'
        | 'lock' | 'unlock' | 'holdCart' | 'clearCart'
        | 'openSheet'; sheet?: SheetId }
  | { kind: 'op'; op: 'closeSheet' };
```

The reducer never mutates cart, shift, or hardware state. Those live
in existing hooks (`usePOSCartAdapter`, `usePOSShifts`,
`usePOSTransactionOffline`, `useHardwareProxy`, …). The reducer only
answers: **which workspace and which sheet is on screen right now.**

## 6. Persistence

Phase is derived from cart + shift on mount:

- no active shift → `idle`
- shift + empty cart → `ready`
- shift + cart items > 0 → `sale`
- shift + `completedTransaction` unread → `receipt`

`splitPortionToPay`, `tipAmount`, `paymentSessionIdempotencyKey`,
`completedTransaction` survive workspace switches but reset on
`newSale`.

## 7. Enforcement

- `SheetShell` requires a `phase` prop; renders null when reducer's
  phase differs (auto-dismiss on phase change).
- Phase-6 architecture test `pos-no-page-dialogs.test.ts` fails if any
  file under `src/apps/pos/terminal/**` imports a `*Dialog` at page
  scope.
- Phase-6 ESLint rule `no-dialog-for-pos-workspace.js` mirrors the
  test at lint time.

## 8. Preserved invariants

- Idempotency key generation for tender is unchanged: retail binds to
  the frozen amount, restaurant binds to the draft transaction id.
  The reducer holds the value; consumers read it via context.
- Business events continue to flow through `pos_outbox` +
  `BusinessSaga` / `SaleSaga`. The reducer subscribes read-only.
- Hardware commands continue to go through `hardwareClient.exec` with
  idempotency keys, per `mem/features/hardware-platform.md`.

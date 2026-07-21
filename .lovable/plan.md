
# POS Terminal — Enterprise Audit & Reconstruction Plan

## 1. Audit verdict (what the terminal is today vs. what it must be)

An enterprise POS is an **operational workstation** that transitions between a small set of business states — Terminal Idle → Sale → Tender → Receipt → Ready — with each state as a full workspace, permanent transaction summary, and touch-first controls. Overrides, discounts, returns, held sales, and payments are workspace transitions or slide-in sheets bound to a business event, not modal popups stacked on a page.

The current implementation is the opposite of that:

- **One monolithic file.** `src/pages/pos/POSTerminal.tsx` is 2,468 lines and owns product discovery, cart, payments, returns, held orders, receipts, restaurant modifiers, bill split, table transfer, mobile scanner, loyalty, age verification, unit selection, cash drawer, and post-payment — as local `useState` toggles.
- **Popup-driven, not workspace-driven.** 15+ dialogs (`PaymentDialog`, `CashDrawerDialog`, `DiscountDialog`, `ReturnDialog`, `HeldTransactionsDialog`, `CustomerSelectDialog`, `LoyaltyRedemptionDialog`, `AgeVerificationDialog`, `ModifierSelectionDialog`, `POSUnitSelectDialog`, `BillSplitDialog`, `TableTransferDialog`, `ReceiptPreviewDialog`, `MobileScannerDialog`, `TerminalLockScreen`, …) rendered from the same page. Payment — the most important state transition in a POS — is a dialog on top of the sale screen, not its own tender workspace.
- **Wrong landing surface.** `/pos` renders `POS.tsx` ("POS Dashboard"), and the actual workstation lives at `/pos/terminal/:registerId`. Cashiers should land on either the terminal or a register-picker, never an ERP dashboard. The workspace-shell sidebar with Reports / Settlements / Kitchen / Settings is admin surface bleeding into cashier surface.
- **IA mismatch.** The permanent transaction summary, tender totals, and change-due panel that define a POS workstation are not permanently visible — they only exist inside the payment dialog. There is no fixed left-rail summary the way Oracle Retail / LS Central / Dynamics 365 Commerce / Square PoS all present.
- **Business-event layer already exists but is under-used by the UI.** `BusinessSaga`, `SaleSaga`, `pos_outbox`, `domainEventBus`, main-process `DeviceManager`, `hardwareClient` are in place and correct (ADR-0014, hardware-platform memory). The UI does not consume the state model these produce — the UI transitions on button clicks, not on committed events.
- **Touch ergonomics.** Numeric keypad exists (`NumericKeypad.tsx`) but is only used inside a few dialogs, not as a permanent tender/quantity affordance. Many touch targets are `h-8` / `h-10` buttons appropriate for admin, not for a 15" retail terminal.

What is already right and must be preserved:
- Hardware layer (main-process `DeviceManager`, `hardwareClient`, saga/outbox, idempotency keys).
- Offline transaction persistence (`usePOSTransactionOffline`, `usePOSSessionsOffline`).
- Scanner architecture (global `useScanCapture`, `scanBus`/`scanRouter`, GS1 interpreter).
- Domain event bus + business-event outbox.
- Standalone full-screen terminal route outside the workspace shell.

## 2. Target workstation model

Business states become routes under the standalone terminal shell, not dialog toggles:

```text
/pos/terminal/:registerId
├── (idle)     → Shift closed / cashier locked → OpenShift / Unlock workspace
├── /sale      → Sale workspace (product discovery + basket + line ops)
│                Slide-in sheets bound to line events:
│                  · line.discount, line.override, line.unit, line.modifier
│                Slide-in sheets bound to sale events:
│                  · customer.assign, loyalty.redeem, age.verify, hold, park
├── /tender    → Dedicated payment workspace (numeric keypad permanent,
│                split-tender rows, change-due, terminal state)
├── /receipt   → Post-payment workspace (auto-print status, reprint,
│                email, next-sale)
├── /return    → Return/exchange workspace (not a dialog)
├── /held      → Held & parked sales workspace
└── /history   → Shift transaction history workspace
```

Every workspace shares a **fixed left rail** with: register + shift badge, cashier, customer, permanent transaction summary (subtotal / tax / discount / tip / grand total), and a locked hardware/status strip. Every workspace shares a **fixed bottom action bar** whose contents change per state (Sale: Hold / Discount / Customer / Pay; Tender: Cash / Card / M-Pesa / Split / Confirm; Receipt: Print / Email / New Sale).

Admin surface (Reports, Settlements, Kitchen, Bookings, Payment Terminals, Settings) leaves the cashier chrome entirely — it belongs behind a Manager mode gate accessible from the terminal via manager override, and remains available under `/pos` for back-office users.

## 3. Phased plan (each phase ships independently)

### Phase 0 — Audit artifact (docs-only, no code)
- Write `docs/audit/2026-07-21-pos-terminal-architecture.md`: current-state map (component graph, dialog inventory, state variables per phase, event flow through outbox/saga), gap list vs. enterprise POS principles, target state model above, migration order, deletion list.
- Add `docs/architecture/POS_WORKSTATION_STATES.md`: the state machine (Idle → Sale → Tender → Receipt → Ready; side-transitions Return, Held, History, Locked), which business events cause transitions, which are commanded, and which sheets are permitted per state.

### Phase 1 — Workstation shell & state machine (no visual change to Sale)
- New `src/apps/pos/terminal/` module.
- `TerminalShell.tsx` — fixed left rail (register, shift, cashier, customer, transaction summary, hardware strip) + top status bar (offline/online, drawer, printer, scanner health via `hardwareClient.runtimeCapability`) + main workspace outlet + bottom action bar slot.
- `useTerminalState.ts` — finite-state reducer over `{ phase: 'idle'|'sale'|'tender'|'receipt'|'return'|'held'|'history'|'locked', activeSheet?: SheetId }`. Transitions are driven by business events (`sale.opened`, `sale.line.added`, `sale.tender.opened`, `sale.paid`, `sale.receipt.settled`), not click handlers. Click handlers dispatch intents; the reducer decides the phase.
- Nested routes under `/pos/terminal/:registerId/{sale,tender,receipt,return,held,history}` with `TerminalShell` as the layout route. `/pos/terminal/:registerId` redirects to the phase the reducer computes from shift/cart state.
- Cutover: `POSTerminal.tsx` becomes `sale.tsx`'s body **verbatim** in Phase 1 so nothing regresses; only the outer shell changes.

### Phase 2 — Extract Tender as a workspace
- Move `PaymentDialog` internals into `terminal/tender/TenderWorkspace.tsx`.
- Permanent `NumericKeypad` on the right; split-tender rows on the left (Cash, Card via `CardTerminalController`, M-Pesa, Voucher, Loyalty redemption); change-due and terminal state permanently visible.
- Entering tender is a route push (`/pos/terminal/:id/tender`) driven by the reducer on `sale.tender.opened`. Back-button returns to Sale with cart intact. Idempotency keys move into the reducer, matching current session-context contract.
- Delete `PaymentDialog` from Sale wiring once the route is live; keep the file until Phase 6 sweep.

### Phase 3 — Extract Receipt, Return, Held, History as workspaces
- `terminal/receipt/ReceiptWorkspace.tsx` replaces `ReceiptPreviewDialog` + `PostPaymentScreen` inline. Owns auto-print status, reprint, email, and "new sale" (F2).
- `terminal/return/ReturnWorkspace.tsx` replaces `ReturnDialog`.
- `terminal/held/HeldWorkspace.tsx` replaces `HeldTransactionsDialog`; `HeldOrdersBar` becomes a rail chip that navigates to it.
- `terminal/history/HistoryWorkspace.tsx` replaces `TransactionHistoryDialog`.

### Phase 4 — Convert remaining popups into event-scoped slide-in sheets
Keep as sheets (they are line- or sale-scoped micro-interactions, not phase changes), but standardise them:
- Line-scoped: `LineDiscountSheet`, `LineUnitSheet`, `LineModifierSheet`, `LineOverrideSheet` — all mount from the basket, all use the same `SheetShell` with the same touch-first layout.
- Sale-scoped: `CustomerAssignSheet`, `LoyaltyRedeemSheet`, `AgeVerifySheet`, `HoldSaleSheet`, `BillSplitSheet`, `TableTransferSheet`, `ManagerOverrideSheet`.
- All sheets consume the reducer and emit intents; none own transactional state.
- Delete the old dialog components in the Phase 6 sweep.

### Phase 5 — Sale workspace decomposition
Split `sale.tsx` (the ex-`POSTerminal.tsx`) into cohesive components under `terminal/sale/`:
- `ProductDiscoveryPanel` (search + grid + category chips + scan-ghost + recovery banner)
- `BasketPanel` (line list, line inline editors, empty state)
- `SaleActionBar` (bottom bar for Sale phase)
Each ≤ ~300 lines; state comes from `usePOSCartAdapter` and the terminal reducer. No new business logic — pure component extraction plus reducer wiring.

### Phase 6 — Cashier chrome & IA cleanup
- Standalone terminal route already exists; make `/pos` for a signed-in cashier auto-navigate to their assigned register's terminal (or a register-picker if unassigned). Admin `/pos` dashboard remains for managers (RBAC gate).
- Remove Reports / Settlements / Kitchen / Bookings / Payment Terminals / Settings from the cashier's terminal chrome; expose them behind Manager mode (existing `ManagerOverrideDialog` becomes the gate) and keep them under `/pos/*` for the back-office workspace shell.
- Sweep-delete replaced dialog files (`PaymentDialog`, `ReturnDialog`, `HeldTransactionsDialog`, `TransactionHistoryDialog`, `ReceiptPreviewDialog`, `PostPaymentScreen`, the sheet-replaced dialogs) and their now-dead imports.
- Update `mem/features/hardware-platform.md` with the workstation-state rule; add `mem/features/pos-workstation.md` documenting the state machine, sheet vs workspace rule, and forbidden re-introduction of top-level dialogs.

### Phase 7 — Guards, tests, verification
- New architecture test `src/test/architecture/pos-no-page-dialogs.test.ts`: fails if any file under `src/apps/pos/terminal/**` imports `@/components/pos/*Dialog` at page scope (sheets are the sanctioned surface).
- New ESLint rule `eslint-rules/no-dialog-for-pos-workspace.js` mirroring the test at lint time.
- Playwright happy-path against localhost: open shift → add via scan → discount line → tender split (cash + M-Pesa) → receipt → new sale; and a return path. Screenshots asserted per phase.
- Verify hardware side-effects still flow through `hardwareClient` and outbox (existing tests in `src/test/architecture/hardware-single-chokepoint.test.ts` must still pass).

## 4. Non-goals (explicit)

- No changes to the hardware layer, `DeviceManager`, drivers, saga, outbox, or `hardwareClient` — that architecture is already correct.
- No visual redesign of admin surfaces (Reports, Settlements, Settings) — they remain in the workspace shell.
- No new business logic. Cart, pricing, tax, loyalty, promotions, ETIMS, offline commit are consumed as-is via existing hooks.
- No framework/library additions.

## 5. Technical details

- Routing: React Router (this app is not on TanStack Router). Nested routes under the existing standalone `/pos/terminal/:registerId` in `src/apps/pos/routes.tsx`; `TerminalShell` becomes the layout route, phase pages are children. Legacy `/pos/terminal/:registerId` with no phase segment renders a redirector that picks the phase from `useTerminalState`.
- State: one reducer per terminal instance, provided via `TerminalStateContext`. Existing hooks (`usePOSCartAdapter`, `usePOSShifts`, `usePOSTransactionOffline`, `useDrawerPolicy`, `usePOSLoyalty`, `usePOSAgeVerification`, `useCustomerDisplay`, `useHardwareProxy`) stay; they become inputs the reducer reacts to, not siblings the JSX polls.
- Business events: reducer subscribes to `domainEventBus` for `sale.*` events emitted by `SaleSaga` / cart adapter. The reducer never writes to the outbox directly.
- Sheets vs Workspaces: workspaces are routes and change phase; sheets are `role="dialog"` slide-ins bound to the current phase and dismissed on phase change. Enforced by `SheetShell` + guard test.
- Touch targets: minimum 48×48 for cashier chrome, 56×56 for tender numeric keys. Fixed rail width 320px, bottom bar 96px, main region fluid.
- Deletion list (Phase 6): `PaymentDialog.tsx`, `ReturnDialog.tsx`, `HeldTransactionsDialog.tsx`, `TransactionHistoryDialog.tsx`, `ReceiptPreviewDialog.tsx`, `PostPaymentScreen.tsx`, plus any dialog whose replacement sheet is live and whose only consumer was `POSTerminal.tsx`.
- Backwards compatibility: no schema, RPC, edge-function, or `pos_outbox` contract changes. Idempotency-key generation for tender preserves the current retail-vs-restaurant rule verbatim.

## 6. Definition of done

- Cashier lands directly in a workspace tied to a business state; every state transition is a route change driven by a committed event, not a click.
- Zero top-level dialogs on the Sale / Tender / Receipt / Return / Held / History workspaces (guard test enforces).
- Fixed transaction summary and hardware status visible in every phase.
- `POSTerminal.tsx` no longer exists as a monolith; `terminal/**` files are each < ~300 lines and single-responsibility.
- Existing hardware, offline, saga, and scanner tests still pass; new state-machine and no-page-dialog tests pass; Playwright happy-path and return-path pass.

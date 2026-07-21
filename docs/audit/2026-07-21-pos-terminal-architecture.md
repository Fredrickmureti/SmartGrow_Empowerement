# POS Terminal — Enterprise Architecture Audit

Date: 2026-07-21
Status: Accepted
Related: `docs/architecture/POS_WORKSTATION_STATES.md`, ADR-0014 (POS
hardware — main-process orchestrator).

## 1. Executive verdict

The current POS terminal is a **page with popups**, not a **workstation
with workspaces**. It ships all cashier functionality inside a single
2,468-line file (`src/pages/pos/POSTerminal.tsx`) that opens 15+ modal
dialogs from local `useState` toggles. Payment — the most important
state transition in any POS — is a `<Dialog>` overlaid on the sale
screen instead of a dedicated tender workspace with a permanent numeric
keypad, split-tender rows, and a change-due panel.

The **backend architecture is enterprise-grade**: main-process
`DeviceManager` (ADR-0014), `hardwareClient` chokepoint, per-device
command queue with idempotency, `SaleSaga` + `pos_outbox` for
crash-replay, offline session persistence, GS1-aware scanner routing,
and a `domainEventBus`. The UI does not consume any of it as a state
model — it transitions on button clicks rather than committed business
events.

This document catalogues the gap and defines the phased path to a
workstation architecture.

## 2. Reference: enterprise POS architectural principles

Distilled from Oracle Retail Xstore, NCR Aloha / Voyix, Toshiba TCx,
SAP CAR/OmniPOS, LS Central (MS Dynamics), Dynamics 365 Commerce,
Shopify POS, Lightspeed Retail, Square Register, and Odoo POS. None
are copied — the invariants they all share are:

1. **Workstation, not page.** The terminal is a full-screen shell with
   fixed chrome (register/shift/cashier/customer/total, hardware
   status). Nothing outside the workstation is visible to the cashier.
2. **Business-state-driven UI.** The workstation transitions between a
   small closed set of phases (Idle → Sale → Tender → Receipt →
   Ready; side-transitions Return, Held, History, Locked). Each phase
   is a full workspace with its own action bar.
3. **Permanent transaction summary.** Subtotal, tax, discount, tip,
   grand total are visible in every phase — never hidden inside a
   dialog.
4. **Popups are line- or sale-scoped micro-interactions**, not phase
   changes. Payment, receipt, return are workspaces; discount, unit,
   modifier, customer-assign are sheets.
5. **Touch-first ergonomics.** Numeric keypad is permanent in tender.
   Primary controls ≥ 48 px; tender keys ≥ 56 px.
6. **OPOS/UPOS role taxonomy** for devices (already honoured — see
   `mem/features/hardware-platform.md`).
7. **Durable per-device queue + saga outbox** for crash-safe commits
   (already honoured — see ADR-0014).
8. **Cashier chrome hides admin.** Reports, settings, kitchen
   configuration, payment-terminal setup are behind a manager gate,
   not in the cashier's sidebar.

## 3. Current state — component and dialog map

### 3.1 Pages
| Path | File | Purpose |
|---|---|---|
| `/pos` | `src/pages/pos/POS.tsx` (468 LOC) | Dashboard — cards for registers, shifts, stats, quick-actions. Admin-shaped. |
| `/pos/terminal/:registerId` | `src/pages/pos/POSTerminal.tsx` (**2,468 LOC**) | The actual workstation. Monolith. |
| `/pos/reports`, `/pos/settlements`, `/pos/settings`, `/pos/kitchen`, `/pos/floor-plan`, `/pos/bookings`, `/pos/payment-terminals`, `/pos/scanner-telemetry` | assorted | Admin / restaurant / setup surface. |
| `/pos/customer-display` | `CustomerDisplay.tsx` | Standalone (correct — outside workspace shell). |
| `/pos/scan/:token` | `MobileScannerPage.tsx` | Standalone (correct). |

### 3.2 Dialogs invoked from `POSTerminal.tsx`
| Dialog | Business meaning | Correct target |
|---|---|---|
| `PaymentDialog` | **Phase change** (Sale → Tender) | Workspace `/pos/terminal/:id/tender` |
| `ReceiptPreviewDialog` + `PostPaymentScreen` | **Phase change** (Tender → Receipt) | Workspace `/pos/terminal/:id/receipt` |
| `ReturnDialog` | **Phase change** (side-transition) | Workspace `/pos/terminal/:id/return` |
| `HeldTransactionsDialog` | **Phase change** (side-transition) | Workspace `/pos/terminal/:id/held` |
| `TransactionHistoryDialog` | **Phase change** (side-transition) | Workspace `/pos/terminal/:id/history` |
| `CashDrawerDialog` | Phase change (drawer management) | Workspace or dedicated shift-tools surface |
| `TerminalLockScreen` | Phase change (Locked) | Workspace overlay driven by reducer |
| `DiscountDialog` | Sale-scoped micro-interaction | Sheet |
| `CustomerSelectDialog` | Sale-scoped | Sheet |
| `LoyaltyRedemptionDialog` | Sale-scoped | Sheet |
| `AgeVerificationDialog` | Sale-scoped (compliance gate) | Sheet |
| `ManagerOverrideDialog` | Cross-cutting gate | Sheet |
| `POSUnitSelectDialog` | Line-scoped | Sheet |
| `ModifierSelectionDialog` | Line-scoped (restaurant) | Sheet |
| `BillSplitDialog` | Sale-scoped (restaurant) | Sheet |
| `TableTransferDialog` | Sale-scoped (restaurant) | Sheet |
| `MobileScannerDialog` | Utility | Sheet |
| `KeyboardShortcutsOverlay` | Utility | Sheet |
| `SendDocumentDialog` | Post-receipt utility | Sheet (inside Receipt workspace) |
| `ShiftReportDialog`, `CloseShiftDialog`, `OpenShiftDialog`, `ReopenShiftDialog` | Shift lifecycle | Idle/Ready workspace surfaces |

### 3.3 Local state observed in `POSTerminal.tsx`
`showPayment`, `showCustomer`, `showCloseShift`, `showHeld`, `showCashDrawer`, `showReturn`, `showDiscount`, `showHistory`, `showReceipt`, `showPostPayment`, `showEmailReceipt`, `showLoyalty`, `showAge`, `showLock`, `showModifier`, `showUnit`, `showBillSplit`, `showTableTransfer`, `showMobileScanner`, `showMobileCart`, `showKeyboardShortcuts`, `splitPortionToPay`, `completedTransaction`, `tipAmount`, `tableSessionId`, `paymentSessionIdempotencyKey`, and cart/session state — **all as sibling `useState` calls in one component**. This is the concrete anti-pattern the plan replaces.

### 3.4 Backend layer (correct, preserved as-is)
- `electron/hardware/DeviceManager` + `SaleSaga` + `pos_outbox` (ADR-0014).
- `src/services/hardware/HardwareClient.ts` — single chokepoint (guarded by `src/test/architecture/hardware-single-chokepoint.test.ts`).
- `src/services/events/domainEventBus.ts` and `BusinessSaga`.
- `src/hooks/pos/usePOSTransactionOffline.ts` — offline commit + replay.
- `src/services/pos/scanBus.ts` / `scanRouter.ts` + global `useScanCapture`.

## 4. Anti-patterns catalogued in current terminal

1. **Popup as phase.** Payment, Receipt, Return, Held, History all open as `<Dialog>` overlays. Phase changes must be routes; only micro-interactions may be popups.
2. **Sibling `useState` phase tracking.** A dozen `show*` booleans replace what should be one `phase` enum in a reducer. Impossible to reason about legal transitions; easy to enter illegal composite states (e.g. `showPayment && showReturn`).
3. **Transaction summary hidden.** Grand total is visible in the basket, but tax breakdown, tip, and change-due appear only inside `PaymentDialog`. Never visible during hand-off to the customer.
4. **Landing is a dashboard.** `/pos` renders admin cards; cashiers should land in the workstation or a register-picker.
5. **Admin surface inside cashier chrome.** Reports, Settlements, Kitchen, Bookings, Payment-Terminals, Settings are all in the sidebar visible to a cashier at the workstation.
6. **Ephemeral numeric keypad.** `NumericKeypad.tsx` exists but is used only inside a few dialogs. Tender must have it permanently visible.
7. **Touch targets too small.** Many `h-8`/`h-10` buttons in the tender/cart paths — appropriate for an admin dashboard, not a 15" retail terminal.
8. **UI doesn't consume the event bus.** `domainEventBus` emits `sale.*` events; the terminal reads none of them for phase transitions.

## 5. Target architecture

See `docs/architecture/POS_WORKSTATION_STATES.md` for the state machine and `mem/features/pos-workstation.md` (added Phase 6) for the enforcement rules.

Summary:

```text
/pos/terminal/:registerId (TerminalShell — fixed rail + status + action bar)
  ├── /sale     — Sale workspace (product discovery + basket + line ops)
  ├── /tender   — Tender workspace (numeric keypad + split-tender + change)
  ├── /receipt  — Post-payment workspace (print/email/next)
  ├── /return   — Return/exchange workspace
  ├── /held     — Held & parked sales workspace
  └── /history  — Shift transaction history workspace
```

`TerminalStateContext` owns `{ phase, activeSheet, ... }` and derives
the current URL from committed business events, not click handlers.
Sheets are `role="dialog"` slide-ins bound to the current phase.

## 6. Migration order and deletion list

**Phase 0** (this doc + `POS_WORKSTATION_STATES.md`) — done in this loop.
**Phase 1** — `terminal/` module with `TerminalShell` + `useTerminalState` + nested routes; `sale.tsx` hosts the current `POSTerminal.tsx` body verbatim to avoid regression.
**Phase 2** — `TenderWorkspace` (replaces `PaymentDialog` at page scope).
**Phase 3** — `ReceiptWorkspace`, `ReturnWorkspace`, `HeldWorkspace`, `HistoryWorkspace`.
**Phase 4** — Sheet standardisation (`LineDiscountSheet`, `CustomerAssignSheet`, `LoyaltyRedeemSheet`, `AgeVerifySheet`, `ManagerOverrideSheet`, `HoldSaleSheet`, `LineUnitSheet`, `LineModifierSheet`, `BillSplitSheet`, `TableTransferSheet`).
**Phase 5** — Sale workspace decomposition (`ProductDiscoveryPanel`, `BasketPanel`, `SaleActionBar`).
**Phase 6** — IA cleanup (cashier landing → workstation; admin gated behind manager); sweep-delete replaced dialogs.

Deletion list (after Phase 6):
- `src/components/pos/PaymentDialog.tsx`
- `src/components/pos/ReturnDialog.tsx`
- `src/components/pos/HeldTransactionsDialog.tsx`
- `src/components/pos/TransactionHistoryDialog.tsx`
- `src/components/pos/ReceiptPreviewDialog.tsx`
- `src/components/pos/PostPaymentScreen.tsx`
- Any dialog whose only consumer was `POSTerminal.tsx` after its sheet replacement lands.

**Phase 7** — Guards + tests: `pos-no-page-dialogs.test.ts`, `eslint-rules/no-dialog-for-pos-workspace.js`, Playwright happy-path + return-path.

## 7. Non-goals

- No hardware-layer changes.
- No schema, RPC, edge-function, or `pos_outbox` contract changes.
- No new business logic; existing hooks are consumed as-is.
- No admin-surface visual redesign.

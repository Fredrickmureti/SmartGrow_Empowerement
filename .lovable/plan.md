# POS Terminal — Enterprise Audit & Reconstruction Plan

> **Status snapshot (2026-07-21):** Phases 0–3a complete + Phase 3b in progress (Held workspace shipped). Next: **History workspace** (Phase 3b.2).

## 1. Audit verdict (what the terminal is today vs. what it must be)

An enterprise POS is an **operational workstation** that transitions between a small set of business states — Terminal Idle → Sale → Tender → Receipt → Ready — with each state as a full workspace, permanent transaction summary, and touch-first controls. Overrides, discounts, returns, held sales, and payments are workspace transitions or slide-in sheets bound to a business event, not modal popups stacked on a page.

The current implementation is the opposite of that:

- **One monolithic file.** `src/pages/pos/POSTerminal.tsx` is 2,500 lines and owns product discovery, cart, payments, returns, held orders, receipts, restaurant modifiers, bill split, table transfer, mobile scanner, loyalty, age verification, unit selection, cash drawer, and post-payment — as local `useState` toggles.
- **Popup-driven, not workspace-driven.** 15+ dialogs (`PaymentDialog`, `CashDrawerDialog`, `DiscountDialog`, `ReturnDialog`, `HeldTransactionsDialog`, `CustomerSelectDialog`, `LoyaltyRedemptionDialog`, `AgeVerificationDialog`, `ModifierSelectionDialog`, `POSUnitSelectDialog`, `BillSplitDialog`, `TableTransferDialog`, `ReceiptPreviewDialog`, `MobileScannerDialog`, `TerminalLockScreen`, …) rendered from the same page.
- **Wrong landing surface.** `/pos` renders `POS.tsx` ("POS Dashboard"); the actual workstation lives at `/pos/terminal/:registerId`. Cashiers should land on either the terminal or a register-picker, never an ERP dashboard.
- **IA mismatch.** No permanent transaction summary / tender totals / change-due panel — they only exist inside the payment dialog.
- **Business-event layer is under-used by the UI.** `BusinessSaga`, `SaleSaga`, `pos_outbox`, `domainEventBus`, main-process `DeviceManager`, `hardwareClient` are correct. The UI transitions on button clicks, not on committed events.
- **Touch ergonomics.** Numeric keypad exists but only inside dialogs; many targets are `h-8` / `h-10`.

What is already right and must be preserved: hardware layer, offline persistence, scanner architecture, domain event bus + outbox, standalone terminal route.

## 2. Target workstation model

Business states become routes under the standalone terminal shell, not dialog toggles:

```text
/pos/terminal/:registerId
├── (idle)     → Shift closed / cashier locked → OpenShift / Unlock workspace
├── /sale      → Sale workspace (product discovery + basket + line ops)
├── /tender    → Dedicated payment workspace
├── /receipt   → Post-payment workspace
├── /return    → Return/exchange workspace
├── /held      → Held & parked sales workspace
└── /history   → Shift transaction history workspace
```

Every workspace shares a fixed left rail (register + shift + cashier + customer + permanent transaction summary + hardware status) and a fixed bottom action bar whose contents change per state. Admin surfaces (Reports, Settlements, Kitchen, Bookings, Payment Terminals, Settings) leave the cashier chrome entirely.

## 3. Phased roadmap & status

### Phase 0 — Audit artifact — **DONE**
- `docs/audit/2026-07-21-pos-terminal-architecture.md` (verdict, dialog inventory, migration order).
- `docs/architecture/POS_WORKSTATION_STATES.md` (state chart, sheets-vs-workspaces rule).

### Phase 1 — Workstation shell & state machine — **DONE**
- `src/apps/pos/terminal/` module with `useTerminalState.ts` (pure reducer, 9 phases, 15 sheets), `TerminalStateContext.tsx` (+ `TerminalStateBridge`), `TerminalShell.tsx` (layout route mounting the provider), `SheetShell.tsx` (auto-dismiss on phase change).
- 23 unit tests in `__tests__/useTerminalState.test.ts`.
- `TerminalShell` mounted as layout route for `/pos/terminal/:registerId`; `POSTerminal` runs inside it.
- **URL ↔ phase sync** (`useTerminalUrlSync`): state changes `replace` the URL to the phase segment; deep links / back-forward / F5 dispatch the matching operator intent. Illegal deep links are ignored and the URL self-corrects.
- Sibling routes registered: `sale`, `tender`, `receipt`, `return`, `held`, `history` (all currently render `POSTerminal`, which is now phase-driven internally).

### Phase 2 — Extract Tender as a workspace — **State cutover DONE; chrome swap PENDING**
- **Done:** `PaymentDialog` visibility is derived from `terminalState.phase === "tender"`. `openTender` freezes the idempotency key (retail-vs-restaurant rule preserved) via reducer op; `backToSale` closes.
- **Pending (2b):** replace the `<Dialog>` chrome with a full-screen route-owned `TenderWorkspace` under `terminal/tender/`. Move the numeric keypad to a permanent right-hand panel, split-tender rows to the left, change-due + terminal status permanent. Delete the dialog wiring once the route is authoritative.

### Phase 3 — Extract Receipt / Return / Held / History — **State cutover DONE (3a); chrome swap PENDING (3b)**
- **Done (3a):** `showHeld`, `showReturn`, `showHistory` are derived reads of `terminalState.phase`; opening dispatches `openHeld/openReturn/openHistory`; closing dispatches `closeSide` (which restores `previousPhase`). The reducer's per-phase legality checks make "only one side workspace at a time" a structural invariant. Verified with 23 passing reducer tests + clean typecheck.
- **Pending (3b):**
  - `terminal/receipt/ReceiptWorkspace.tsx` replaces `ReceiptPreviewDialog` + `PostPaymentScreen`. Owns auto-print status, reprint, email, F2 → new sale.
  - `terminal/return/ReturnWorkspace.tsx` replaces `ReturnDialog`.
  - `terminal/held/HeldWorkspace.tsx` replaces `HeldTransactionsDialog`; `HeldOrdersBar` becomes a rail chip that navigates via `openHeld`.
  - `terminal/history/HistoryWorkspace.tsx` replaces `TransactionHistoryDialog`.
  - Each workspace consumes `useTerminalContext()`, receives no `open/onOpenChange` props, and mounts on its sibling route (Phase 1 routes are already in place).

### Phase 4 — Slide-in sheets — **PENDING**
Convert line- and sale-scoped micro-interactions to a standardised `SheetShell`:
- Line: `LineDiscountSheet`, `LineUnitSheet`, `LineModifierSheet`, `LineOverrideSheet`.
- Sale: `CustomerAssignSheet`, `LoyaltyRedeemSheet`, `AgeVerifySheet`, `HoldSaleSheet`, `BillSplitSheet`, `TableTransferSheet`, `ManagerOverrideSheet`.
- All consume the reducer and emit intents; none own transactional state.

### Phase 5 — Sale workspace decomposition — **PENDING**
Split ex-`POSTerminal.tsx` into `terminal/sale/`:
- `ProductDiscoveryPanel`, `BasketPanel`, `SaleActionBar` (each ≤ ~300 lines, single-responsibility). No new business logic.

### Phase 6 — Cashier chrome & IA cleanup — **PENDING**
- Signed-in cashier `/pos` auto-navigates to assigned register (or picker); admin dashboard stays behind RBAC.
- Remove Reports / Settlements / Kitchen / Bookings / Payment Terminals / Settings from cashier terminal chrome; expose via Manager mode.
- Sweep-delete replaced dialog files.

### Phase 7 — Guards & tests — **PENDING**
- ESLint rule: no `Dialog`/`Sheet` imports inside `terminal/**/*Workspace.tsx`.
- Route-level test: mounting any workspace must not render a top-level `[role="dialog"]` from the workspace's own tree.
- Playwright happy-path and return-path against the new URLs.

## 4. Non-goals (explicit)

- No changes to the hardware layer, `DeviceManager`, drivers, saga, outbox, or `hardwareClient`.
- No visual redesign of admin surfaces.
- No new business logic (cart, pricing, tax, loyalty, promotions, ETIMS, offline commit consumed as-is).
- No framework/library additions.

## 5. Technical details

- Routing: React Router. `TerminalShell` layout route + phase-named sibling routes under `/pos/terminal/:registerId`. `useTerminalUrlSync` mounts inside the shell.
- State: one reducer per terminal instance via `TerminalStateContext`. Existing hooks stay; they become inputs.
- Business events: reducer subscribes to `domainEventBus` for `sale.committed`, `pos.payment_completed`, `pos.session_idle`.
- Sheets vs Workspaces: workspaces are routes and change phase; sheets are `role="dialog"` slide-ins bound to the current phase, auto-dismissed on phase change by `SheetShell`.
- Touch targets: min 48×48 for cashier chrome, 56×56 for tender numeric keys. Fixed rail 320px, bottom bar 96px.
- Deletion list (Phase 6): `PaymentDialog.tsx`, `ReturnDialog.tsx`, `HeldTransactionsDialog.tsx`, `TransactionHistoryDialog.tsx`, `ReceiptPreviewDialog.tsx`, `PostPaymentScreen.tsx`, plus any dialog whose replacement sheet is live.
- Backwards compatibility: no schema, RPC, edge-function, or `pos_outbox` contract changes. Idempotency-key generation for tender preserves the current retail-vs-restaurant rule verbatim.

## 6. Definition of done

- Cashier lands directly in a workspace tied to a business state; every state transition is a route change driven by a committed event, not a click.
- Zero top-level dialogs on Sale / Tender / Receipt / Return / Held / History workspaces (guard test enforces).
- Fixed transaction summary and hardware status visible in every phase.
- `POSTerminal.tsx` no longer exists as a monolith; `terminal/**` files each < ~300 lines and single-responsibility.
- Existing hardware, offline, saga, and scanner tests still pass; new state-machine and no-page-dialog tests pass; Playwright happy-path and return-path pass.

## 7. Handoff — instructions for the next agent

**Before writing any new code, verify the current milestone (Phases 0 → 3a) is enterprise-grade correct.** Do this in order:

1. **Read the guardrails.** `docs/audit/2026-07-21-pos-terminal-architecture.md`, `docs/architecture/POS_WORKSTATION_STATES.md`, and this plan. Do not skip.
2. **Confirm the state machine still owns lifecycle:** grep `src/pages/pos/POSTerminal.tsx` for `useState.*show(Payment|Held|Return|History)`. There must be **none** — these must all be derived reads of `terminalState.phase` with dispatch-based setters. If any regressed to local state, fix before proceeding.
3. **Run the reducer suite:** `bunx vitest run src/apps/pos/terminal` → 23 tests must pass. `bunx tsgo --noEmit` must be clean.
4. **Smoke the URL sync** in the preview: navigate to `/pos/terminal/:id`, add a cart item (URL must become `/sale`), open Held (`/held`), close (back to `/sale`), refresh on `/held` (must reopen Held). Browser back/forward must round-trip.
5. **Verify no orphan wiring:** every dispatch site (`openTender`, `openHeld`, `openReturn`, `openHistory`, `closeSide`, `backToSale`) must have exactly one corresponding UI trigger; there must be no dead legacy `setShow*` callers left in the tree.

**Only after verification passes**, resume at **Phase 3b — Route-owned workspaces for Held / Return / History / Receipt**:

- Create `src/apps/pos/terminal/{held,return,history,receipt}/` with a `*Workspace.tsx` per phase.
- Each workspace: reads `useTerminalContext()`, consumes `usePOSShifts` for `activeShift`, and renders the phase surface **without** `<Dialog>` chrome (use the workspace region provided by `TerminalShell`; the shell will grow a fixed rail + bottom bar as part of Phase 5, but the workspace bodies can land first).
- Swap the sibling routes in `src/apps/pos/routes.tsx` from `<POSTerminal />` to the new workspace components one at a time, in this order: **Held → History → Return → Receipt** (safest → most coupled).
- Once a workspace is live on its route, remove its dialog mount from `POSTerminal.tsx` and delete the corresponding `show*` derived variable + shim setter. Do NOT delete the underlying dialog component file yet — the Phase 6 sweep owns deletions.
- After each workspace ships: run typecheck + reducer tests, smoke the URL sync, then update this plan's status block before starting the next workspace.

Do not begin Phase 4 (sheets) until Phase 3b is complete. Do not begin Phase 5 (Sale decomposition) until Phase 4 is complete. Chronological progression is mandatory — no jumping.

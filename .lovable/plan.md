# POS Terminal — Verification Report & Continuation Plan

## Phase A — Verification of the previous engineer's work

Reference docs used: `docs/audit/2026-07-21-pos-terminal-architecture.md` (the roadmap) and `docs/architecture/POS_WORKSTATION_STATES.md` (the state contract). No `plan.md` at repo root; the roadmap lives in that audit doc.

| Claimed phase | Claim | Verdict | Evidence |
|---|---|---|---|
| Phase 0 — docs + state chart | Done | **Confirmed** | Audit doc + WORKSTATION_STATES doc present and internally consistent. |
| Phase 1 — `terminal/` module: `TerminalShell`, reducer, provider, URL sync, bridge | Done | **Partially done** | `src/apps/pos/terminal/{TerminalShell,TerminalStateContext,SheetShell,useTerminalState,useTerminalUrlSync}.tsx/ts` exist and are wired in `src/apps/pos/routes.tsx`. Reducer is pure, guarded, and matches the state chart. Sibling routes (`sale`, `tender`, `receipt`, `return`, `held`, `history`) are declared **but all resolve to the legacy `POSTerminal` monolith**, so the URL is honest while the surface is not. Acceptable as a Phase-1 shim, but must not be mistaken for completion. |
| Phase 2 — `TenderWorkspace` replaces `PaymentDialog` at page scope | Not started | **Confirmed not done** | `POSTerminal.tsx:72` still imports `PaymentDialog` and mounts it at `:2302` gated on `terminalState.phase === "tender"`. Numeric keypad is not permanent. Transaction summary still lives inside the dialog. |
| Phase 3 — `ReceiptWorkspace`, `ReturnWorkspace`, `HeldWorkspace`, `HistoryWorkspace` | Partial | **Only `HeldWorkspace` extracted** (`src/apps/pos/terminal/held/HeldWorkspace.tsx`, mounted at `:2346`). `ReturnDialog`, `TransactionHistoryDialog`, `ReceiptPreviewDialog` are still `<Dialog>` overlays inside `POSTerminal`. |
| Phase 4 — sheet standardisation | Not started | **Confirmed not done** | `SheetShell` exists but no sheet consumers use it; every sale-scoped popup still lives as a bespoke `<Dialog>` in `POSTerminal` with its own `useState` toggle. |
| Phase 5 — Sale workspace decomposition | Not started | `POSTerminal.tsx` is **2,529 LOC** with 28 `useState` calls — worse than the number audited (2,468 LOC), so drift has occurred, not decomposition. |
| Phase 6 — IA cleanup, cashier landing, dialog sweep-delete | Not started | `/pos` still renders the admin dashboard; no files from the deletion list have been removed. |
| Phase 7 — guards + tests | Not started | Only `__tests__/useTerminalState.test.ts` exists for the reducer. No `pos-no-page-dialogs.test.ts`, no `no-dialog-for-pos-workspace.js` ESLint rule, no Playwright happy-path. |

### Architectural regressions / risks discovered during verification
1. **Route siblings are cosmetic.** `/tender`, `/receipt`, `/return`, `/held`, `/history` all mount `POSTerminal`, so deep links land on a monolith that then computes the phase and pops the matching dialog. This satisfies the URL contract but not the workspace contract.
2. **`showReceipt` is still ad-hoc `useState`** (`POSTerminal.tsx:510`), bypassing the reducer's `recordCompletion` path. Phase can be `receipt` while `showReceipt` is false and vice versa — the exact composite-state bug the audit called out.
3. **Sheets have no runtime enforcement in production code.** `SheetShell` is unused, so the "auto-dismiss on phase change" invariant only holds in the reducer, not in the DOM.
4. **`domainEventBus.on("*")` wildcard subscription** in the provider is fine, but the reducer treats `sale.committed` and `pos.payment_completed` as terminal events without checking they belong to the current register — a stray event from a sibling terminal in the same tab (dev mode) would incorrectly graduate this terminal to receipt. Needs a register-id guard.
5. `/pos` landing is admin-shaped; a cashier opening the app lands on a dashboard rather than a register picker → workstation.

## Phase B — Revised plan (supersedes the phase list in the audit doc)

Order chosen so each step ships a working terminal and lets us delete a legacy dialog file at the end of the step. No flag-day rewrite.

### Step 1 — Harden Phase-1 substrate (blockers for everything after)
- Add register-id scoping to `PHASE_DRIVING_EVENTS` handling: reducer only reacts to events whose payload matches the mounted `registerId`. Bridge passes `registerId` into the provider.
- Move `showReceipt` and `completedTransaction` fully into the reducer via `recordCompletion` + `newSale`; delete the sibling `useState` in `POSTerminal`.
- Add architecture test `src/__tests__/pos-no-page-dialogs.test.ts` — scans `src/apps/pos/terminal/**` and `src/pages/pos/POSTerminal.tsx` and fails on `import … Dialog from …` for the phase-change dialog list. Fails today; each subsequent step removes one entry until it passes.
- Add `eslint-rules/no-dialog-for-pos-workspace.js` mirroring the same list.

### Step 2 — TenderWorkspace (replaces PaymentDialog)
- New `src/apps/pos/terminal/tender/TenderWorkspace.tsx` — full-region surface, permanent numeric keypad (reuse `NumericKeypad`), split-tender rows, change-due panel, permanent transaction summary rail.
- New `src/apps/pos/terminal/tender/hooks.ts` — thin adapter over existing `usePOSTransactionOffline`, `useHardwareProxy`, `useSplitTender` (no new business logic).
- Route `/pos/terminal/:id/tender` → `TenderWorkspace` (not `POSTerminal`).
- Remove `PaymentDialog` mount and imports from `POSTerminal`; delete `src/components/pos/PaymentDialog.tsx` and its now-unreferenced helpers.
- Playwright happy-path: sale → tender → cash + card split → receipt.

### Step 3 — ReceiptWorkspace (replaces ReceiptPreviewDialog + PostPaymentScreen)
- New `src/apps/pos/terminal/receipt/ReceiptWorkspace.tsx` — receipt preview, print, email/SMS via `SendDocumentSheet`, "New Sale" action dispatches `newSale`.
- Route `/pos/terminal/:id/receipt` → `ReceiptWorkspace`.
- Delete `ReceiptPreviewDialog`, `PostPaymentScreen`.

### Step 4 — ReturnWorkspace and HistoryWorkspace (parallels HeldWorkspace)
- Lift the two remaining side-transition dialogs into full workspaces at `/return` and `/history` using the same structure as `HeldWorkspace`.
- Route bindings updated; delete `ReturnDialog`, `TransactionHistoryDialog`.

### Step 5 — Sheet standardisation
- Convert every sale/line-scoped popup to a `SheetShell`-hosted component with a `SheetId` from the reducer:
  `LineDiscountSheet`, `LineUnitSheet`, `LineModifierSheet`, `LineOverrideSheet`, `CustomerAssignSheet`, `LoyaltyRedeemSheet`, `AgeVerifySheet`, `HoldSaleSheet`, `BillSplitSheet`, `TableTransferSheet`, `ManagerOverrideSheet`, `SendDocumentSheet`, `UnlockSheet`.
- Delete matching `*Dialog` components once no consumer remains.
- Sheet toggles migrate from `useState` to `openSheet(sheetId)` / `closeSheet()` on the reducer — per-phase allow-list becomes runtime-enforced by `SheetShell`.

### Step 6 — SaleWorkspace decomposition
- Split the Sale portion of `POSTerminal` into: `SaleWorkspace` (route-owned), `ProductDiscoveryPanel`, `BasketPanel`, `SaleActionBar`, `TransactionSummaryRail` (also mounted by Tender/Receipt for permanent visibility).
- `POSTerminal.tsx` becomes a thin compatibility redirect that renders `<Navigate to="sale" replace />` when the phase is `sale`; then deleted once route siblings all point at their own workspaces.

### Step 7 — Cashier landing + IA cleanup
- `/pos` for cashier role → register picker that routes into the workstation; admin surface (Reports, Settlements, Kitchen, Bookings, Payment-Terminals, Settings) gated behind a manager role check in `POSShellLayout`.
- Remove sidebar admin items from the workstation shell (`TerminalShell` already isolated; verify no admin nav leaks in).

### Step 8 — Guards, tests, closeout
- Turn on the architecture test and ESLint rule (both were red since Step 1); confirm green.
- Playwright: happy-path, return-path, held-resume, deep-link `/receipt` after refresh, browser back/forward across phases.
- Update `docs/audit/2026-07-21-pos-terminal-architecture.md` §6 with actual completion dates and prune the "future phases" list.
- Update `mem://features/pos-workstation.md` with the enforcement rules for future contributors.

## Non-goals (unchanged from the parent audit)
- No hardware-layer changes.
- No schema, RPC, edge-function, or `pos_outbox` contract changes.
- No new business logic; existing hooks are consumed as-is.
- No admin-surface visual redesign.

## Technical notes
- Reducer stays pure; every new workspace subscribes to `useTerminalContext()` for phase + sheet, and to existing hooks for cart/shift/hardware.
- `SheetShell` becomes the ONLY way to open a sheet under `/pos/terminal/*`; the ESLint rule forbids raw `<Dialog>` in workspace files.
- Register-id scoping added to the domain-event handler so multi-terminal dev sessions don't cross-contaminate reducers.
- Deletions happen at the end of each step, not batched at the end, so `git blame` shows the replacement landing with the removal.

## Resume point
Start at **Step 1** — the previous engineer's Phase-1 substrate is real but has two latent bugs (`showReceipt` sibling state, missing register-id scoping) that will contaminate every subsequent workspace if left in place.

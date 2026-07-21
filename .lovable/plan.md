# POS Terminal — Verification + Continuation

## Phase 1 — Verification (independently checked against the codebase)

| Prior claim | Verdict | Evidence |
|---|---|---|
| Steps 1, 2, 4, 5.0, 5.1, 5.2 complete | **Confirmed** | Reducer + `SHEETS_ALLOWED_PER_PHASE`, `TenderWorkspace`, `ReturnWorkspace`, `HistoryWorkspace`, `ReceiptPreviewBody` (thin), `ReceiptPreviewSheet`, `POSReports` inline dialog, deleted `ReceiptPreviewDialog.tsx`. |
| Step 3 closeout Slices A–D complete | **Confirmed** | `PostPaymentSurface` is the canonical export (`rg PostPaymentScreen` returns only stale doc/comment strings — no imports or JSX). `ReceiptDataProvider` mounted in `TerminalShell` between `TerminalStateProvider` and `<Outlet />`. `POSTerminal.tsx` no longer holds `completedTransaction` state nor calls `useResolvedPrintPolicyWithDevice`. |
| Slice C.2 deferred (cart still component-scoped in `POSTerminal`) | **Confirmed** | `usePOSCartAdapter` still invoked at `POSTerminal.tsx:231`. All six sibling routes (`sale/tender/receipt/return/held/history`) in `src/apps/pos/routes.tsx:130–135` still resolve to `<POSTerminal />`. |
| Guardrail suites green | **Trusted, will re-run at Step 6 entry** | `pos-workspace-dialogs`, `pos-receipt-model-boundary`, `pos-receipt-renderer-contract`, `stage-b-receipt-snapshot`. |
| Stale `PostPaymentScreen` strings in comments | **Cleanup** | Non-behavioural — `useHardwareProxy.ts` docstring, `renderers/index.ts`, `ReceiptDocumentModel.ts`, `HistoryWorkspace.tsx` inline comments, one arch-test comment. Sweep during Step 6. |

**Verdict:** The prior agent's log is accurate. Nothing marked complete is actually pending. Resume point stands: **Step 6 — SaleWorkspace decomposition with cart-ownership lift**.

## Phase 2 — Plan adjustments (evidence-driven)

No new phases required. Two small additions justified by the codebase read:

- **A. Stale-symbol sweep.** Update the `PostPaymentScreen` comment strings surfaced above in the same commit as Slice C.2 to keep grep clean and prevent contributors re-introducing the old name.
- **B. Cart provider must expose the exact `usePOSCartAdapter` return shape unchanged** (retail + restaurant branches). `POSTerminal` currently threads ~40 cart methods into JSX; renaming or narrowing the surface would balloon this into a semantic refactor. `CartProvider` is a pure ownership lift, not an API redesign.

Everything else in `.lovable/plan.md` (Steps 6–8, non-goals, technical notes) stands.

## Phase 3 — Execution: Step 6 (SaleWorkspace decomposition + cart lift)

Order of operations, single wave:

1. **CartProvider (ownership lift).** Create `src/apps/pos/terminal/sale/CartContext.tsx` that internally calls `usePOSCartAdapter({ tableSessionId, registerId, shiftId, tableNumber })` from props and exposes the identical return object via `useCart()`. Mount inside `TerminalShell` as a peer of `ReceiptDataProvider`. `POSTerminal.tsx` replaces its L231 `usePOSCartAdapter(...)` invocation with `const cart = useCart();` — zero call-site changes downstream.
2. **SaleWorkspace extraction.** Move the sale-phase render tree out of `POSTerminal.tsx` into `src/apps/pos/terminal/sale/SaleWorkspace.tsx`, decomposed into `ProductDiscoveryPanel`, `BasketPanel`, `SaleActionBar`, `TransactionSummaryRail`. The rail is a peer component so Tender + Receipt can mount it for permanent visibility (business-state driven UI requirement from parent prompt).
3. **ReceiptRoute wrapper.** `src/apps/pos/terminal/receipt/ReceiptRoute.tsx` — thin: reads `useReceiptData()` + `useTerminalContext()`, renders `<ReceiptWorkspace />`. Unblocks Slice C.2.
4. **Route rewire.** `src/apps/pos/routes.tsx` L130 (`sale` → `<SaleWorkspace />`) and L132 (`receipt` → `<ReceiptRoute />`). `tender/return/held/history` still point at `<POSTerminal />` — later waves.
5. **POSTerminal shrinks to a router shim.** Once `sale` and `receipt` are gone, `POSTerminal` still hosts `tender/return/held/history` internally via `terminalState.phase`. Extend the shim contract explicitly (comment + arch test) — no user-visible change.
6. **Route-sibling uniqueness test.** `src/test/architecture/pos-terminal-route-siblings.test.ts` — statically parses `routes.tsx` and asserts no two `terminal/:registerId` siblings share the same route element. Prevents regressing back to `<POSTerminal />`-for-everything.
7. **Stale symbol sweep** (Phase-2 item A above).

### Verification gate before ending Step 6
- `bunx tsgo --noEmit` clean.
- Four terminal guardrail suites + new sibling-uniqueness test green.
- Playwright smoke: `sale → hold → recall → tender → receipt → new-sale` — cart state must survive the route-sibling swap. This is the exact regression Slice C.2 deferral was protecting against; passing it closes both Slice C.2 and Step 6.

## Phase 4 — Steps 7 & 8 (unchanged from prior plan)

- **Step 7 — Cashier landing + IA gating.** `/pos` becomes a register-picker → workstation for cashier role. Manager-only admin nav (Reports, Settlements, Kitchen, Bookings, Payment Terminals, Settings) gated in `POSShellLayout` via existing `SubscriptionAccessContext`/role hooks. No new role model.
- **Step 8 — Close-out.** Extract remaining `tender/return/held/history` workspaces one-per-wave, delete `POSTerminal.tsx`, extend `no-dialog-for-pos-workspace` to cover the file's former path, ship Playwright coverage for deep-link refresh + multi-register isolation, update `docs/audit/2026-07-21-pos-terminal-architecture.md`, save `mem://features/pos-workstation.md` with enforcement rules.

## Non-goals (unchanged)
No hardware-layer changes. No schema/RPC/edge-function/`pos_outbox` changes. No new business logic. No admin-surface visual redesign.

## Technical notes
- `CartProvider` is a lift, not a rewrite — the `usePOSCartAdapter` return object is the public contract; changing it is out of scope for Step 6.
- Do NOT inline `PostPaymentSurface` into `ReceiptWorkspace`/`HistoryWorkspace` — the shared surface is deliberate (Slice B design note).
- Pre-existing failing suite `src/test/pos/stage-5-void.test.ts` is a separate ticket — do not fix opportunistically.

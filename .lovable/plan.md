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

**Progress log (this session):**
- ✅ **6.1 CartProvider (ownership lift) — done.** `src/apps/pos/terminal/sale/CartContext.tsx` created. Mounted in `TerminalShell` as a peer of `ReceiptDataProvider`. `POSTerminal.tsx:231` now calls `useCart()` — zero downstream call-site changes. Adapter return shape preserved verbatim. Cart state now survives sibling-route swaps. Typecheck clean.
- ✅ **Phase-2A stale-symbol sweep — done.** All non-test `PostPaymentScreen` comment strings renamed to `PostPaymentSurface` (`renderers/index.ts`, `ReceiptDocumentModel.ts`, `HistoryWorkspace.tsx`, `useHardwareProxy.ts`, `pos-receipt-renderer-contract.test.ts` docstrings). `rg PostPaymentScreen src/` now returns zero.
- ✅ **6.2a — `ProductDiscoveryPanel` + `BasketPanel` extracted.** Both pure prop-driven under `src/apps/pos/terminal/sale/components/`. No hooks/context reads inside.
- ✅ **6.2b (partial) — `TransactionSummaryRail` extracted.** Pure prop-driven, sized for reuse inside Tender + Receipt routes (per parent-prompt permanent-visibility requirement). Optional `size` prop for the future Tender/Receipt mounts.
- ✅ **6.2b (rest) — `SaleActionBar` extracted.** `src/apps/pos/terminal/sale/components/SaleActionBar.tsx` — pure prop-driven, consumes a semantic `SaleActionBarCallbacks` object (8 callbacks) instead of 15 raw setters. Callbacks memoised in `POSTerminal.tsx` right before the render tree. Desktop action grid + quick-pay + primary pay button all replaced. Mobile cart drawer action buttons intentionally left inline for now (own follow-up during SaleWorkspace hoist so the mobile drawer can adopt the same component with a `variant="mobile"` prop rather than churn twice).
- ⏭ **Next: 6.2c** hoist the four extracted panels (`ProductDiscoveryPanel`, `BasketPanel`, `TransactionSummaryRail`, `SaleActionBar`) into `src/apps/pos/terminal/sale/SaleWorkspace.tsx`; adopt the same `SaleActionBar` in the mobile drawer to eliminate the duplicated inline block. Then **6.2d** `ReceiptRoute` + route-sibling test, then route rewire.

**Session totals (running):** `POSTerminal.tsx` 2,505 → 2,203 LOC (−302). Four sale-phase presentational components extracted (`ProductDiscoveryPanel`, `BasketPanel`, `TransactionSummaryRail`, `SaleActionBar`). All typechecks clean (`bunx tsgo --noEmit`).

1. **CartProvider (ownership lift).** Create `src/apps/pos/terminal/sale/CartContext.tsx` that internally calls `usePOSCartAdapter({ tableSessionId, registerId, shiftId, tableNumber })` from props and exposes the identical return object via `useCart()`. Mount inside `TerminalShell` as a peer of `ReceiptDataProvider`. `POSTerminal.tsx` replaces its L231 `usePOSCartAdapter(...)` invocation with `const cart = useCart();` — zero call-site changes downstream.
2. **SaleWorkspace extraction.** Move the sale-phase render tree out of `POSTerminal.tsx` into `src/apps/pos/terminal/sale/SaleWorkspace.tsx`, decomposed into `ProductDiscoveryPanel`, `BasketPanel`, `SaleActionBar`, `TransactionSummaryRail`. The rail is a peer component so Tender + Receipt can mount it for permanent visibility (business-state driven UI requirement from parent prompt).
3. **ReceiptRoute wrapper.** `src/apps/pos/terminal/receipt/ReceiptRoute.tsx` — thin: reads `useReceiptData()` + `useTerminalContext()`, renders `<ReceiptWorkspace />`. Unblocks Slice C.2.
4. **Route rewire.** `src/apps/pos/routes.tsx` L130 (`sale` → `<SaleWorkspace />`) and L132 (`receipt` → `<ReceiptRoute />`). `tender/return/held/history` still point at `<POSTerminal />` — later waves.
5. **POSTerminal shrinks to a router shim.** Once `sale` and `receipt` are gone, `POSTerminal` still hosts `tender/return/held/history` internally via `terminalState.phase`. Extend the shim contract explicitly (comment + arch test) — no user-visible change.
6. **Route-sibling uniqueness test.** `src/test/architecture/pos-terminal-route-siblings.test.ts` — statically parses `routes.tsx` and asserts no two `terminal/:registerId` siblings share the same route element. Prevents regressing back to `<POSTerminal />`-for-everything.
7. **Stale symbol sweep** (Phase-2 item A above). *— shipped ahead of the wave; safe in isolation.*

### Verification gate before ending Step 6
- `bunx tsgo --noEmit` clean.
- Four terminal guardrail suites + new sibling-uniqueness test green.
- Playwright smoke: `sale → hold → recall → tender → receipt → new-sale` — cart state must survive the route-sibling swap. This is the exact regression Slice C.2 deferral was protecting against; passing it closes both Slice C.2 and Step 6.

### Resume point for next session
**For the next agent — verification first, then continue:**

1. **Verify prior work before writing any code.**
   - `rg -n "ProductDiscoveryPanel|BasketPanel|TransactionSummaryRail|SaleActionBar" src/pages/pos/POSTerminal.tsx` must show 4 imports + 4 JSX usages, no stale inline copies of the desktop action grid.
   - `rg -n "PostPaymentScreen" src/` must return zero.
   - `usePOSCartAdapter` must be called **only** inside `src/apps/pos/terminal/sale/CartContext.tsx` — `rg -n "usePOSCartAdapter\\(" src/` should return exactly one call site (plus the type-only import in the extracted components). `POSTerminal.tsx` must consume `useCart()` only.
   - `bunx tsgo --noEmit` clean.
   - Confirm the four extracted components under `src/apps/pos/terminal/sale/components/` are **pure prop-driven** (no `use*` hook or context reads inside their bodies — type-only `ReturnType<typeof usePOSCartAdapter>` imports are fine).

2. **Resume point: 6.2c — SaleWorkspace hoist.**
   - Create `src/apps/pos/terminal/sale/SaleWorkspace.tsx` that renders the sale-phase layout (product discovery + basket + summary + action bar) by consuming `useCart()`, `useTerminalContext()`, `useReceiptData()`, and the shift/register context already established in `TerminalShell`.
   - Adopt `SaleActionBar` inside the mobile cart drawer at the same time (deleting the duplicated inline block around former L1918 in `POSTerminal.tsx`) so the workspace owns one action-bar surface, not two.
   - Keep `POSTerminal.tsx` responsible for `tender / return / held / history` until Step 8. Do **not** try to delete `POSTerminal.tsx` in this wave — Slice C.2 only requires `sale` + `receipt` to become sibling-unique routes.

3. **Then 6.2d — `ReceiptRoute` + route rewire + sibling-uniqueness architecture test.** Land all three in one commit per the plan.

4. **Trace before extract.** `SendDocumentDialog` (email receipt, ~L2400 in current `POSTerminal.tsx`), all hardware/print consumers, and the `holdTransaction`/`openPaymentSession`/`recordPaymentTender`/`commitPaymentSession` flow read cart, shift, receipt, and hardware state that still lives in the monolith. Map every reader before moving it into `SaleWorkspace` / `TerminalShell` — a blind hoist will strand these consumers.

5. **Do not** re-order phases, extract `tender/return/held/history` opportunistically, or touch the hardware layer. Chronological execution per Steps 6 → 7 → 8.

## Phase 4 — Steps 7 & 8 (unchanged from prior plan)

- **Step 7 — Cashier landing + IA gating.** `/pos` becomes a register-picker → workstation for cashier role. Manager-only admin nav (Reports, Settlements, Kitchen, Bookings, Payment Terminals, Settings) gated in `POSShellLayout` via existing `SubscriptionAccessContext`/role hooks. No new role model.
- **Step 8 — Close-out.** Extract remaining `tender/return/held/history` workspaces one-per-wave, delete `POSTerminal.tsx`, extend `no-dialog-for-pos-workspace` to cover the file's former path, ship Playwright coverage for deep-link refresh + multi-register isolation, update `docs/audit/2026-07-21-pos-terminal-architecture.md`, save `mem://features/pos-workstation.md` with enforcement rules.

## Non-goals (unchanged)
No hardware-layer changes. No schema/RPC/edge-function/`pos_outbox` changes. No new business logic. No admin-surface visual redesign.

## Technical notes
- `CartProvider` is a lift, not a rewrite — the `usePOSCartAdapter` return object is the public contract; changing it is out of scope for Step 6.
- Do NOT inline `PostPaymentSurface` into `ReceiptWorkspace`/`HistoryWorkspace` — the shared surface is deliberate (Slice B design note).
- Pre-existing failing suite `src/test/pos/stage-5-void.test.ts` is a separate ticket — do not fix opportunistically.

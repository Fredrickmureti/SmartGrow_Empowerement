# POS Terminal — Verification & Continuation (re-issued)

## Phase A — Verified state (independently checked against code)

| Prior claim | Verdict | Evidence |
|---|---|---|
| Step 1: reducer + register-id scoping + derived show flags + arch test + ESLint rule | **Confirmed** | `TerminalStateContext.tsx`, `useTerminalState.ts` (SheetId, `SHEETS_ALLOWED_PER_PHASE`), `architecture.pos-workspace-dialogs.test.ts`, `eslint-rules/no-dialog-for-pos-workspace.js`, derived `showHeld/Return/History` at POSTerminal.tsx:518‑520. |
| Step 2: `TenderWorkspace` replaces `PaymentDialog`; dialog deleted | **Confirmed** | `src/apps/pos/terminal/tender/TenderWorkspace.tsx` present; no `PaymentDialog.tsx`. |
| Step 3: `ReceiptWorkspace` | **Partial** | `src/apps/pos/terminal/receipt/ReceiptWorkspace.tsx` exists but only wraps `PostPaymentScreen`. `POSTerminal.tsx` still imports `ReceiptPreviewDialog` (L95, L2412) and `PostPaymentScreen` (L96), and `showReceipt` local `useState` still lives at L510. |
| Step 4: `ReturnWorkspace` + `HistoryWorkspace` lifted, dialogs deleted | **Confirmed** | `terminal/return/ReturnWorkspace.tsx` and `terminal/history/HistoryWorkspace.tsx` exist; `ReturnDialog.tsx`/`TransactionHistoryDialog.tsx` absent. `HistoryWorkspace` still overlays `PostPaymentScreen` for reprint (expected — collapses when Step 3 lands). |
| Step 5 checkpoint 5.0: extract `ReceiptPreviewBody`, thin `ReceiptPreviewDialog` | **Confirmed** | `ReceiptPreviewBody.tsx` 583 LOC; `ReceiptPreviewDialog.tsx` 66 LOC. |
| Step 5.1: `ReceiptPreviewSheet` + `sale.receiptPreview` SheetId | **Confirmed** | `src/apps/pos/terminal/sale/ReceiptPreviewSheet.tsx` present; `SheetId` union + `SHEETS_ALLOWED_PER_PHASE.sale` include `"sale.receiptPreview"`; `showReceipt` `useState` removed from `POSTerminal`; both pro-forma triggers dispatch `openSheet("sale.receiptPreview")`. |
| Step 5.2: migrate `POSReports` off `ReceiptPreviewDialog` + delete dialog | **Confirmed** | `POSReports` inlines a local `<Dialog><ReceiptPreviewBody/></Dialog>`; `src/components/pos/ReceiptPreviewDialog.tsx` deleted; four guardrail tests (`stage-b-receipt-snapshot`, `stage-5-void`, `pos-receipt-renderer-contract`, `pos-receipt-model-boundary`) re-pointed at `ReceiptPreviewBody`. |
| Steps 6–8: SaleWorkspace decomposition, cashier landing/IA gating, closeout guards | **Not started** | `POSTerminal.tsx` still ~2,540 LOC; route siblings `/sale /tender /receipt /return /held /history` all still resolve to `<POSTerminal />` (`src/apps/pos/routes.tsx:130‑135`). `/pos` still admin dashboard. |
| Known-flaky `stage-4-returns.test.ts` cross-tender override | **Confirmed pre-existing** | Belongs to a separate refunds ticket; do not fix opportunistically. |

**Conclusion:** Steps 1, 2, 4, and Step 5.0 are genuinely complete. Step 3 exists as a wrapper only — the two dialog/PostPayment mounts inside the monolith are still the real receipt path. Steps 5.1 → 8 are open. Resume at Step 5.1 (Body-in-Sheet), then close out Step 3 by dissolving the monolith's receipt mounts before Step 6.

## Phase A.1 — Adjustments to the prior plan

Additions justified by evidence during verification (not scope creep):

1. **Explicit Step 3 closeout inside Step 6.** Deleting `ReceiptPreviewDialog.tsx` and `PostPaymentScreen.tsx` is only safe once (a) `ReceiptPreviewSheet` owns the pro-forma path and (b) `ReceiptWorkspace` inlines the post-payment surface. Sequence these together, not in Step 3 alone.
2. **Route-sibling activation guard.** After Step 6, add a route-level assertion (unit test on `routes.tsx`) that no two sibling paths under `terminal/:registerId` share the same element — prevents regressing back to `<POSTerminal />`-for-everything.
3. **`HistoryWorkspace`'s embedded `PostPaymentScreen` reprint overlay** collapses into a shared `ReceiptWorkspace` render, not a fresh sheet — keeps one receipt surface.
4. **Step 7 gating** uses the existing `SubscriptionAccessContext` / role check pattern already in `POSShellLayout`; do not introduce a new role model.

Everything else in the prior plan (Steps 5.1, 5.2, 6, 7, 8, non-goals, technical notes) is re-issued unchanged.

## Phase B — Remaining implementation (resume point)

### Step 5.1 — `ReceiptPreviewSheet` + reducer sheet-id (immediate next)
1. Add `"sale.receiptPreview"` to `SheetId` and to the `sale`-phase entry of `SHEETS_ALLOWED_PER_PHASE` in `useTerminalState.ts`.
2. Create `src/apps/pos/terminal/sale/ReceiptPreviewSheet.tsx` — `<SheetShell sheet="sale.receiptPreview" title="Print Bill">` wrapping `<ReceiptPreviewBody />`. Reads the pro-forma transaction from local state on `POSTerminal` (the two `setCompletedTransaction({ id: "pro-forma", ... })` sites near L1969 and L2221) and calls `closeSheet()` from `onClose`.
3. In `src/pages/pos/POSTerminal.tsx`:
   - Delete `const [showReceipt, setShowReceipt] = useState(false);` (L510).
   - Replace both `setShowReceipt(true)` triggers (~L1988, L2241) with `openSheet("sale.receiptPreview")`.
   - Replace the `<ReceiptPreviewDialog open={showReceipt} … />` mount (~L2412) with `<ReceiptPreviewSheet transaction={completedTransaction} />`.
   - Keep `completedTransaction` local state (feeds both the pro-forma sheet AND the post-payment receipt path).
4. Verify: architecture guard + `no-dialog-for-pos-workspace` at 0 errors; Playwright smoke `sale → Print Bill → cart intact → dismiss`.

### Step 5.2 — Migrate `POSReports` off `ReceiptPreviewDialog`
Inline a local `<Dialog><ReceiptPreviewBody/></Dialog>` shell in `POSReports` (legit page dialog, not inside the workstation), then **delete** `src/components/pos/ReceiptPreviewDialog.tsx`.

### Step 3 closeout — dissolve monolith receipt path (folded into Step 6 entry)
- **Slice A (done)** — Relocated `src/components/pos/PostPaymentScreen.tsx` → `src/apps/pos/terminal/receipt/PostPaymentSurface.tsx` (workstation-scoped module). Consumers updated: `ReceiptWorkspace.tsx` and `HistoryWorkspace.tsx` now import from `./PostPaymentSurface` / `../receipt/PostPaymentSurface`. Guardrail whitelists updated in `pos-receipt-model-boundary.test.ts` (adds `PostPaymentSurface`, `ReceiptWorkspace`, `ReceiptPreviewSheet`, `HistoryWorkspace`) and `pos-receipt-renderer-contract.test.ts` (path-refs + `ReceiptPreviewBody` allowed for `generateDocumentEscPosBytes` since Step 5.0). Typecheck clean; targeted architecture + stage-b tests pass. Pre-existing stage-5 void-schema failures are unrelated (separate ticket).
- **Slice B (done)** — `PostPaymentSurface` re-chromed as a workstation section: outer wrapper switched from `role="dialog" fixed inset-0 z-50` to `absolute inset-0 z-40` (no dialog role — the workspace is not a modal). `ReceiptWorkspace` simplified to render `<PostPaymentScreen>` directly (no double `<section>` wrap, no duplicate Escape handler — the surface owns its own hotkeys). `HistoryWorkspace` reprint overlay unchanged in behaviour: it still wraps the surface in its own `absolute inset-0 z-50` overlay above the history grid so dismissing returns to the list. Typecheck clean; `pos-receipt-model-boundary`, `pos-receipt-renderer-contract`, and `stage-b-receipt-snapshot` all green.
  - Design decision: **do not fork `PostPaymentSurface`**. Inlining ~700 LOC of hardware/print/preview logic into `ReceiptWorkspace` (and duplicating it in `HistoryWorkspace`) would create the exact drift the original docstring warns about. `PostPaymentSurface` IS the shared receipt surface; the two consumers stay thin (workspace/reducer glue only). Slice D is therefore reframed as "delete the `PostPaymentScreen` symbol name / rename the export to match the file" rather than a physical deletion.
- **Slice C.1 (done)** — Introduced `src/apps/pos/terminal/receipt/ReceiptDataContext.tsx` exporting `ReceiptDataProvider` + `useReceiptData()` + `CompletedPOSTransaction` (superset type compatible with both `LiveTransactionInput` and `ReceiptPreviewTransaction`). Provider mounted inside `TerminalShell` (below `TerminalStateProvider`, above `<Outlet />`) so every sibling route under `/pos/terminal/:registerId/*` can consume it. `POSTerminal`: removed the local `useState<{ … }>` for `completedTransaction` and the entire `useResolvedPrintPolicyWithDevice` + `postPaymentPolicy` `useMemo` block; both now come from `useReceiptData()`. All three `setCompletedTransaction(...)` call sites (post-tender at L1114-ish, and the two "Print Bill" pro-forma sites) are unchanged in behaviour — the setter signature matches. `TerminalShell` now also reads `useBusinesses()` + `activeShift.branch_id` to feed the provider (react-query dedupes with `POSTerminal`'s existing subscription). Typecheck clean; `pos-receipt-model-boundary`, `pos-receipt-renderer-contract`, and `stage-b-receipt-snapshot` all green.
- **Slice C.2 (deferred — see Step 6)** — Wiring `/pos/terminal/:id/receipt` to a route-owned `ReceiptRoute` is blocked by cart ownership. Retail mode's `usePOSCartAdapter` wraps in-memory `usePOSCart`, which is component-scoped to `POSTerminal`. Swapping the receipt sibling to a non-`POSTerminal` element would unmount `POSTerminal` on `sale → receipt`, and remounting it on `receipt → sale` (new-sale) would drop any interim state. In practice the receipt phase begins post-tender so the cart *is* empty at that transition, so the swap is arguably safe today — but as long as `sale` and `receipt` are siblings of the SAME parent (`TerminalShell`) and one is a bare `POSTerminal` while the other isn't, the mount graph is asymmetric and any future cart-persisted flow (hold-and-recall, split-tender back-out) will regress silently. Correct sequencing is to land Step 6 first (SaleWorkspace + lifted cart ownership out of `POSTerminal`), then swap `/receipt` to `ReceiptRoute` as part of the same wave. The `sibling-uniqueness` route test also moves to that wave.
- **Slice D (done)** — Renamed the exported symbol `PostPaymentScreen` → `PostPaymentSurface` (matches the file name from Slice A). Updated: props interface `PostPaymentScreenProps` → `PostPaymentSurfaceProps`; the two consumers (`ReceiptWorkspace.tsx`, `HistoryWorkspace.tsx`); the two guardrail regexes in `pos-receipt-renderer-contract.test.ts` (lines 91 & 111); and stale docstring/comment breadcrumbs in `POSTerminal.tsx` (L1265, L1275, L2382). No behaviour change. Typecheck clean; `pos-receipt-model-boundary`, `pos-receipt-renderer-contract`, and `stage-b-receipt-snapshot` all green (17/17).

### Step 6 — SaleWorkspace decomposition
Split `POSTerminal.tsx` (2,507 LOC) into:
- `SaleWorkspace` (route-owned at `/pos/terminal/:id/sale`),
- `ProductDiscoveryPanel`, `BasketPanel`, `SaleActionBar`, `TransactionSummaryRail` (rail also mounted by Tender + Receipt for permanent visibility).
- **Cart ownership lift** (bundled with Step 6): move `usePOSCartAdapter` out of `POSTerminal` into a `CartProvider` mounted by `TerminalShell` (peer of `ReceiptDataProvider`) so cart state survives route-sibling swaps. This unblocks Slice C.2 and every subsequent per-route workspace.

Reduce `POSTerminal.tsx` to a redirect shim, then delete once all sibling routes point at their own workspaces. Add the route-sibling uniqueness test from Phase A.1 as part of this wave (route-owned `SaleWorkspace` + route-owned `ReceiptRoute` land together).

### Step 7 — Cashier landing + IA gating
- `/pos` renders a register-picker → workstation for cashier role.
- Hide admin surfaces (Reports, Settlements, Kitchen, Bookings, Payment Terminals, Settings) behind a manager role check in `POSShellLayout` using existing `SubscriptionAccessContext`/role hooks.
- Verify no admin nav leaks into `TerminalShell`.

### Step 8 — Guards, tests, closeout
- Architecture guard extended to `src/pages/pos/POSTerminal.tsx` once emptied (or file deleted).
- Playwright: happy-path, return, held-resume, deep-link `/receipt` refresh, browser back/forward across phases, multi-terminal register-id isolation.
- Update `docs/audit/2026-07-21-pos-terminal-architecture.md` §6 with actual completion dates.
- Save `mem://features/pos-workstation.md` with the enforcement rules.

## Non-goals
No hardware-layer changes; no schema/RPC/edge-function/`pos_outbox` changes; no new business logic (existing hooks consumed as-is); no admin-surface visual redesign.

## Technical notes
- Reducer stays pure; every new workspace reads phase + sheet via `useTerminalContext()` and cart/shift/hardware via existing hooks.
- Each step lands the replacement **and** deletes the legacy file in the same commit.
- After Step 6, sibling routes stop being cosmetic — each phase URL renders its own workspace, deep-link refresh works without the monolith.
- Pre-existing failing suites unrelated to this roadmap: `src/test/pos/stage-5-void.test.ts` (void RPC/schema — separate ticket). Do not fix opportunistically.

## Resume point
Steps 1, 2, 4, 5.0, 5.1, 5.2 complete. **Step 3 closeout Slices A + B + C.1 + D complete**; Slice C.2 deliberately deferred and folded into Step 6 (cart-ownership lift is the true blocker). Current shared state:
- `PostPaymentSurface` (workstation module, canonical export name) is the single receipt surface for both `ReceiptWorkspace` (active) and `HistoryWorkspace` (reprint).
- `ReceiptDataProvider` (mounted by `TerminalShell`) owns `completedTransaction` + resolved `PrintPolicyHint`.
- All four terminal-scoped guardrail suites are green (`pos-workspace-dialogs`, `pos-receipt-model-boundary`, `pos-receipt-renderer-contract`, `stage-b-receipt-snapshot`). Typecheck clean.
- `POSTerminal.tsx` is still ~2,507 LOC and still the element behind every `terminal/:registerId/*` sibling route.

**Next agent — start here:**
1. **Verify Slice D**: `rg -n "PostPaymentScreen" src/` should return zero matches (all comments, exports, and tests migrated to `PostPaymentSurface`). `bunx tsgo --noEmit` clean. `bunx vitest run src/test/architecture/pos-receipt-model-boundary.test.ts src/test/architecture/pos-receipt-renderer-contract.test.ts src/test/pos/stage-b-receipt-snapshot.test.ts` shows 17/17 passing.
2. **Verify Slice C.1 still holds**: `rg -n "useResolvedPrintPolicyWithDevice\|const \[completedTransaction" src/pages/pos/POSTerminal.tsx` returns nothing; `useReceiptData()` is the only source in the file.
3. Proceed to **Step 6 — SaleWorkspace decomposition WITH cart-ownership lift**. Order of operations:
   a. Extract `usePOSCartAdapter` invocation from `POSTerminal.tsx` (~L231) into a new `CartProvider` under `src/apps/pos/terminal/sale/CartContext.tsx`; mount it in `TerminalShell` as a peer of `ReceiptDataProvider`. `POSTerminal` consumes it via `useCart()`.
   b. Extract `SaleWorkspace` (product discovery + basket + action bar + summary rail) from `POSTerminal` into `src/apps/pos/terminal/sale/SaleWorkspace.tsx`, route-owned at `/pos/terminal/:id/sale`.
   c. Extract `ReceiptRoute` (thin wrapper: `useReceiptData()` + `useTerminalContext()` → `<ReceiptWorkspace />`) at `src/apps/pos/terminal/receipt/ReceiptRoute.tsx`.
   d. Update `src/apps/pos/routes.tsx` L130 (sale) and L132 (receipt) to point at their route-owned elements. Other siblings (`tender`, `return`, `held`, `history`) still resolve to `<POSTerminal />` until their workspaces are extracted in later waves.
   e. Add `src/test/architecture/pos-terminal-route-siblings.test.ts` asserting no two `terminal/:registerId` siblings share the same route element.
   f. Verify: typecheck + full guardrail suite + a Playwright smoke of `sale → hold → recall → tender → receipt → new-sale` to prove cart state survives the route sibling swap (the exact regression the C.2 deferral was protecting against).
4. Do NOT inline the ~700-LOC `PostPaymentSurface` body into `ReceiptWorkspace`/`HistoryWorkspace` — the shared surface is deliberate (see Slice B design note).

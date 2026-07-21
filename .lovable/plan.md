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
- `ReceiptWorkspace` becomes the sole owner of the post-payment surface — inline the current `PostPaymentScreen` body into it, keeping `PrintPolicyHint` and the change-due/tender panels as sub-components under `apps/pos/terminal/receipt/`.
- Point `HistoryWorkspace` reprint overlay at the shared receipt surface (extract the shared summary into `ReceiptSummary`).
- Wire route `/pos/terminal/:id/receipt` in `routes.tsx` to `ReceiptWorkspace` (stop routing to `POSTerminal`).
- Delete `src/components/pos/PostPaymentScreen.tsx` once no imports remain.

### Step 6 — SaleWorkspace decomposition
Split `POSTerminal.tsx` (2,545 LOC) into:
- `SaleWorkspace` (route-owned at `/pos/terminal/:id/sale`),
- `ProductDiscoveryPanel`, `BasketPanel`, `SaleActionBar`, `TransactionSummaryRail` (rail also mounted by Tender + Receipt for permanent visibility).

Reduce `POSTerminal.tsx` to a redirect shim, then delete once all sibling routes point at their own workspaces. Add the route-sibling uniqueness test from Phase A.1.

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

## Resume point
Steps 1, 2, 4, 5.0, 5.1, 5.2 complete. Resume at **Step 3 closeout / Step 6 entry** — dissolving the shared `PostPaymentScreen` shim by extracting its body into `apps/pos/terminal/receipt/PostPaymentSurface.tsx` (so `ReceiptWorkspace` and `HistoryWorkspace` both consume the workstation-scoped module), then pointing the `/receipt` route sibling at `ReceiptWorkspace` directly and beginning the `POSTerminal` decomposition.

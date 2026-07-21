# POS Terminal — Verification & Continuation Plan

## Phase A — Verification of the previous engineer's claims

Read `.lovable/plan.md`, `docs/audit/2026-07-21-pos-terminal-architecture.md`, and `docs/architecture/POS_WORKSTATION_STATES.md`, then diffed against the code.

| Claim | Verdict | Evidence |
|---|---|---|
| Step 1 — reducer hardening, register-id scoping, phase-derived show flags, architecture test + ESLint rule | **Confirmed** | `src/apps/pos/terminal/TerminalStateContext.tsx`, `src/__tests__/architecture.pos-workspace-dialogs.test.ts`, `eslint-rules/no-dialog-for-pos-workspace.js` present; `showHeld/Return/History` are derived (POSTerminal.tsx:518-520). |
| Step 2 — `TenderWorkspace` replaces `PaymentDialog`; `PaymentDialog.tsx` deleted | **Confirmed** | `src/components/pos/PaymentDialog.tsx` absent; `src/apps/pos/terminal/tender/TenderWorkspace.tsx` present; only remaining `PaymentDialog` reference is `CardPaymentModal` (unrelated device modal). |
| Step 3 — ReceiptWorkspace | **Not started** | `POSTerminal.tsx` still imports and mounts `ReceiptPreviewDialog` (L95, L2421) and `PostPaymentScreen` (L96, L2436). |
| Steps 4–7 | **Not started** | `ReturnDialog` (L93, L2389) and `TransactionHistoryDialog` (L94, L2396) still mounted; `POSTerminal.tsx` is **2,558 LOC** (drifted +29 since audit); `/pos` still admin dashboard; no sheet migrations. |
| Route siblings `/tender /receipt /return /held /history` | **Cosmetic** | All still resolve to `<POSTerminal />` in `src/apps/pos/routes.tsx:131-135`; only workspace actually route-owned is `Held` via reducer, not routing. |

### Additional issues found during verification
- `showReceipt` (POSTerminal.tsx:510) remains a bare `useState` used for the pro-forma preview path. Not the composite-state bug the audit called out (that one is fixed), but it's the last non-reducer receipt trigger and should collapse into the reducer when `ReceiptWorkspace` lands.
- Route siblings still all point at `<POSTerminal />`. Each new workspace must both (a) mount at its route AND (b) delete the dialog it replaces, otherwise deep-link + refresh continues to render the monolith.

**Conclusion:** Prior engineer's Steps 1–2 are genuinely complete. Steps 3–8 are open. Phase B below is the plan from `.lovable/plan.md` re-issued unchanged in ordering, with Step 3 as the immediate next milestone.

## Phase B — Remaining implementation

### Step 3 — ReceiptWorkspace (next)
- Add `src/apps/pos/terminal/receipt/ReceiptWorkspace.tsx`: full-region `<section>` mirroring `TenderWorkspace` shape, reads `terminalState.lastCompletion`, exposes **Print**, **Email/SMS** (via existing `SendDocumentSheet` path), **New Sale** (dispatches `newSale`).
- Route `/pos/terminal/:id/receipt` → `ReceiptWorkspace` in `src/apps/pos/routes.tsx` (stop routing to `POSTerminal`).
- Inside `POSTerminal`, replace the `phase === "receipt"`-gated `ReceiptPreviewDialog` + `PostPaymentScreen` mounts with the same workspace when rendered under the monolith path, so both entry points converge.
- Collapse `showReceipt` useState into the reducer (pro-forma preview becomes a sheet, not a page dialog).
- **Delete** `src/components/pos/ReceiptPreviewDialog.tsx` and `src/components/pos/PostPaymentScreen.tsx` once no imports remain.
- Tests: extend the architecture guard entry list; add Playwright happy-path `sale → tender → receipt → new sale`.

### Step 4 — ReturnWorkspace + HistoryWorkspace
- Lift `ReturnDialog` and `TransactionHistoryDialog` into full workspaces at `/return` and `/history`, using `HeldWorkspace` as the template.
- Route bindings updated; delete the two dialog files.

### Step 5 — Sheet standardisation via `SheetShell`
- Migrate every sale/line-scoped popup to `SheetShell` with a `SheetId` on the reducer: `LineDiscount`, `LineUnit`, `LineModifier`, `LineOverride`, `CustomerAssign`, `LoyaltyRedeem`, `AgeVerify`, `HoldSale`, `BillSplit`, `TableTransfer`, `ManagerOverride`, `SendDocument`, `Unlock`.
- Replace per-popup `useState` toggles with `openSheet(id)` / `closeSheet()`.
- Delete matching `*Dialog` components after migration; per-phase sheet allow-list becomes runtime-enforced.

### Step 6 — SaleWorkspace decomposition
- Split the Sale portion of `POSTerminal.tsx` (currently 2,558 LOC) into:
  - `SaleWorkspace` (route-owned at `/pos/terminal/:id/sale`)
  - `ProductDiscoveryPanel`, `BasketPanel`, `SaleActionBar`, `TransactionSummaryRail` (rail also mounted by Tender + Receipt for permanent visibility).
- `POSTerminal.tsx` reduces to a redirect shim, then is deleted once all sibling routes point at their own workspaces.

### Step 7 — Cashier landing + IA gating
- `/pos` renders a register-picker → workstation for cashier role; admin surfaces (Reports, Settlements, Kitchen, Bookings, Payment-Terminals, Settings) hidden behind a manager role check in `POSShellLayout`.
- Verify no admin nav leaks into `TerminalShell`.

### Step 8 — Guards, tests, closeout
- Architecture guard `architecture.pos-workspace-dialogs.test.ts` and the ESLint rule flip fully green (they already forbid Dialog inside `src/apps/pos/terminal/**`; extend to `src/pages/pos/POSTerminal.tsx` once step 6 empties it).
- Playwright: happy-path, return, held-resume, deep-link `/receipt` refresh, browser back/forward across phases, multi-terminal register-id isolation.
- Update `docs/audit/2026-07-21-pos-terminal-architecture.md` §6 with actual completion dates.
- Save `mem://features/pos-workstation.md` with the enforcement rules.

## Non-goals
- No hardware-layer changes, no schema/RPC/edge-function/`pos_outbox` changes, no new business logic (existing hooks are consumed as-is), no admin-surface visual redesign.

## Technical notes
- Reducer stays pure; every new workspace reads phase + sheet via `useTerminalContext()` and cart/shift/hardware via the existing hooks.
- Each step lands the replacement AND deletes the legacy file in the same commit so `git blame` shows the swap.
- After Step 6, route siblings are no longer cosmetic — each phase URL renders its own workspace, and deep-link refresh works without the monolith fallback.

## Resume point

**Step 5 — In progress (checkpoint 5.0).** Shared receipt-preview body extracted:

- **Created** `src/components/pos/ReceiptPreviewBody.tsx` — shell-agnostic component owning snapshot resolution (`useReceiptSnapshot`), hardware-vs-PDF print decisioning (ADR-0008 unified pipeline), the summary/printer-preview tabs, and the nested `PrintFallbackDialog` + `SendDocumentDialog` overlays. Exports `ReceiptPreviewTransaction` type for reuse.
- **Rewrote** `src/components/pos/ReceiptPreviewDialog.tsx` (568 → ~65 LOC) as a thin Radix `Dialog` shell around `ReceiptPreviewBody`. Public API unchanged: `POSTerminal.tsx` and `POSReports.tsx` continue to consume it without modification.
- Typecheck clean for both files (`npx tsgo --noEmit` shows zero `ReceiptPreview*` diagnostics).

### Next agent — verification checklist (do this FIRST)

1. Confirm `ReceiptPreviewDialog` still renders correctly from **both** consumers by grep: `rg -n "ReceiptPreviewDialog" src/` — expect exactly two mount sites (`POSTerminal.tsx` and `POSReports.tsx`) plus the definition itself.
2. Run `bunx tsgo --noEmit` and `bunx eslint src/apps/pos/terminal src/components/pos/ReceiptPreview*` — must be 0 errors.
3. Inspect `ReceiptPreviewBody.tsx` for behavior parity vs. the pre-refactor dialog body (loading skeleton, `useCurrentSettings` switch, ETIMS overlay, VOID/REFUND watermarks, Clone button → `onClose()` cascade). All logic was ported verbatim; only outer Dialog chrome and title were externalized.

### Next milestone — Step 5.1: `ReceiptPreviewSheet` + reducer sheet-id

Only after verification succeeds:

1. Add `"sale.receiptPreview"` to `SheetId` and to the `sale`-phase entry of `SHEETS_ALLOWED_PER_PHASE` in `src/apps/pos/terminal/useTerminalState.ts` (see enum near L32-50).
2. Create `src/apps/pos/terminal/sale/ReceiptPreviewSheet.tsx` — `<SheetShell sheet="sale.receiptPreview" title="Print Bill">` wrapping `<ReceiptPreviewBody />`. Reads the pro-forma transaction from a small piece of local state on `POSTerminal` (the two `setCompletedTransaction({ id: "pro-forma", ... })` call sites at L1969 and L2221) and calls `closeSheet()` from `onClose`.
3. In `src/pages/pos/POSTerminal.tsx`:
   - Delete `const [showReceipt, setShowReceipt] = useState(false);` at L510.
   - Replace both `setShowReceipt(true)` triggers (L1988, L2241) with `openSheet("sale.receiptPreview")` from `useTerminalContext()`.
   - Replace the `<ReceiptPreviewDialog open={showReceipt} … />` mount around L2412 with `<ReceiptPreviewSheet transaction={completedTransaction} />`.
   - Keep `completedTransaction` local state (it feeds both the pro-forma preview sheet AND the post-payment `ReceiptWorkspace`).
4. Verify: architecture guard test still green; ESLint rule `no-dialog-for-pos-workspace` still 0 errors; Playwright smoke `sale → Print Bill → cart intact → dismiss`.

### Then Step 5.2: migrate `POSReports` onto a report-local dialog

`POSReports` legitimately needs a page dialog (it's not inside the workstation), but it should stop importing `ReceiptPreviewDialog` from `components/pos` and instead inline its own `<Dialog><ReceiptPreviewBody/></Dialog>` shell — this frees us to delete `ReceiptPreviewDialog.tsx` entirely, closing out Step 5.

### After Step 5 fully lands

Proceed to **Step 6** (SaleWorkspace decomposition) per the roadmap above — do NOT skip ahead to Steps 7-8; the monolith must be dissolved before route-siblings can stop being cosmetic.

### Known pre-existing failures (not caused by refactor, do not fix opportunistically)

- `stage-4-returns.test.ts` "enforces cross-tender refunds via a manager override": SQL drift, RPC no longer emits `'cross_tender_requires_override'`. Belongs to a separate refunds-hardening ticket.



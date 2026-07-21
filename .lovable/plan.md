
# POS Terminal — Verification + Enerpize-style Workspace Reshape

## Phase 1 — Verification against `.lovable/plan.md`

Re-run the "Resume point" checks the previous agent left before continuing any new work. Findings so far from a first pass:

| Prior claim | Verdict | Evidence |
|---|---|---|
| `SaleWorkspace` extracted, `POSTerminal` consumes `useCart()` | Confirmed | `POSTerminal.tsx:117,239,1698` |
| Panels pure prop-driven under `sale/components/` | Confirmed | `src/apps/pos/terminal/sale/` |
| `PostPaymentScreen` symbol sweep clean | Needs re-run | grep on fresh tree |
| Step 6.2d (`ReceiptRoute`, route rewire, sibling-uniqueness test) | Not started | `routes.tsx` still points all six terminal sibling routes at `<POSTerminal />` |
| `SendDocumentDialog` / `showEmailReceipt` relocation into `ReceiptRoute` | Not started | still inline in `POSTerminal.tsx` |
| Cart/shell persistence across phase URL changes (`sale/tender/receipt/return/held/history`) | Structurally correct — `TerminalShell` is the layout route, `CartProvider` + `ReceiptDataProvider` live above `<Outlet />`. Behaviour still needs a Playwright pass. | `TerminalShell.tsx`, `routes.tsx` |

If any check fails on rerun, that fix is inserted before Phase 2 begins.

## Phase 2 — Diagnosis of the user's concrete complaint

The user's screenshots show two real problems, not just aesthetics:

1. **Payment page is a full-screen replacement.** Our current `/pos/terminal/:id/tender` mounts `TenderWorkspace` as a full `<section>`. The cart, product context, and top summary that were on `/sale` visually **disappear** — the cashier loses the transaction context they were just working in. Enerpize keeps the cart + net-payable summary permanently on the right; only the tender controls (methods list + numeric keypad) enter on the left. That is the enterprise-POS pattern the parent prompt calls for ("transaction summaries remain fixed", "payment becomes a dedicated workspace *with* permanent summary rail").
2. **History is a full-region takeover.** Same issue: clicking History replaces the sale workspace entirely. Enerpize slides a receipts panel down over the sale surface with rows `[Receipt#, Date, Paid?, Refund, View]`, `View` opens an inline receipt preview with Print/Cancel — the sale workspace underneath is never torn down.
3. **Broken tender state** ("Call a supervisor / Something went wrong. Please call a supervisor. Reload terminal"). The dark screenshot shows the tender surface in a fatal error state, and the caption "Only Cash is enabled on this register" indicates the resolver is running but the workspace's own render tree is throwing. Root cause has to be found before any redesign — a pretty broken screen is still broken.

The URL still changes because the reducer + `useTerminalUrlSync` map phases to route segments — that is correct for deep-linking, browser back/forward, and F5. The user's real objection is not "the URL changed" but "the workspace context vanished." Fix the layout, keep the URL contract.

## Phase 3 — Execution

### Step A — Close out prior Step 6.2d (unblocks everything)

Exactly the resume point in `.lovable/plan.md` §Phase 3, item 2, no scope creep:

- Create `src/apps/pos/terminal/receipt/ReceiptRoute.tsx` — thin: `useReceiptData()` + `useTerminalContext()`, renders `<ReceiptWorkspace />`.
- Lift `showEmailReceipt` + `<SendDocumentDialog>` out of `POSTerminal.tsx` into `ReceiptRoute`.
- Flip `SaleWorkspace` to consume its context hooks directly and drop the transitional prop surface.
- `routes.tsx`: `sale` → `<SaleWorkspace />`, `receipt` → `<ReceiptRoute />`. `tender/return/held/history` still on `<POSTerminal />` for now.
- Add `src/test/architecture/pos-terminal-route-siblings.test.ts` — static parse of `routes.tsx`, asserts no two `terminal/:registerId` siblings share the same element.
- `bunx tsgo --noEmit` + all terminal guardrail suites must pass before Step B.

### Step B — Diagnose and fix the tender "Call a supervisor" state

- Reproduce against the running preview (Playwright, cash-only register, cart with 1 item → tap Pay). Capture the console + network trace at the failure.
- Trace to the origin (`TenderWorkspace` render, `resolvePaymentMethods` output, `POSShellErrorBoundary` `resetKey`, `SaleSaga`/`openPaymentSession`). Fix at the origin, not with a try/catch.
- Regression test: `src/test/pos/tender-cash-only-render.test.tsx` — cash-only register mounts `TenderWorkspace` without throwing and renders the numeric keypad + "Pay Cash" affordance.

### Step C — Reshape Tender into a persistent-shell workspace (Enerpize pattern)

Layout, no business-logic changes. Every payment invariant from ADR 0009 (four-axis payment row, resolver readiness, tender validation) is preserved verbatim.

```
+----------------------------------------------------------------+
|  Top rail (unchanged): register • branch • cashier • badges     |
+----------------------------------+-----------------------------+
|  Payment methods (rows)          |  TRANSACTION SUMMARY RAIL   |
|  [Cash] [ 80.00 ] [x]            |  (mounted from SaleWorkspace|
|  [+ Add method]                  |   — same component, no      |
|                                  |   remount)                  |
|                                  |                             |
|  Numeric keypad                  |  Subtotal        Ksh 80.00  |
|   7 8 9   | quick-pay chips      |  Net Payable     Ksh 80.00  |
|   4 5 6   | (Exact / next round) |  Paid            Ksh 80.00  |
|   1 2 3   |                      |  Change          Ksh  0.00  |
|   0 . ⌫   |                      |                             |
|                                  |  [ Confirm payment ]        |
+----------------------------------+-----------------------------+
```

- Reuse `TransactionSummaryRail` (already extracted, already reusable) as the right rail so cart totals are permanently visible during tender — this is a direct requirement from the parent prompt ("transaction summaries remain fixed").
- Left column: `PaymentMethodRows` (existing rows) + `NumericKeypad` + quick-pay chips. All existing method drivers (cash / M-Pesa / card / bank / voucher / credit) are unchanged.
- Delete the current full-width Tender chrome; keep the reducer contract (Back → `backToSale`, Confirm → `commitPaymentSession`).
- Resolver-blocked methods render as disabled chips with reason + Settings link — already the resolver contract from ADR 0009, we just surface it in the new left column.
- Escape and the header Back button still dispatch `backToSale`; browser Back still works because the URL still transitions `/tender` → `/sale`.

### Step D — Reshape History into a slide-down overlay panel

The sale workspace stays mounted underneath.

- New `src/apps/pos/terminal/history/HistoryPanel.tsx` — an overlay `<section>` positioned inside the terminal content region (not a `<Dialog>`, not a full-region takeover). Slides in from the top of the content area with a translucent scrim over the sale grid; the summary rail on the right and the top rail stay visible.
- Row schema: `Receipt#, Date, Total, Paid?, [Refund] [View]`. `View` opens an inline `ReceiptPreviewSheet` (already extracted) stacked over the panel; `Cancel` returns to the panel; `Print` triggers the existing hardware path.
- Reducer behaviour: `openHistory` still transitions phase → `history` and the URL still becomes `/history`, but the sale workspace remains mounted behind the panel because the panel is rendered as an overlay sibling of `SaleWorkspace`, not a replacement. State-wise this means `phase === "history"` renders `SaleWorkspace` (read-only) + `HistoryPanel` on top; `backToSale` dismisses the panel.
- Void / manager-override / refund flows are preserved (they were already sub-modals inside `HistoryWorkspace`; they simply move into `HistoryPanel`).
- Delete the old full-region `HistoryWorkspace` after parity is confirmed.

### Step E — Guardrails + Playwright coverage

- Extend `no-dialog-for-pos-workspace` to also fail on `<Dialog>` inside `HistoryPanel`/`TenderWorkspace`.
- Playwright: `sale → tap Pay → tender surface renders with summary rail visible → Confirm → receipt → new sale`; and `sale → History → View → Print → Cancel → back to sale (cart still intact)`.
- Guardrail test: cart line count is identical before entering tender and after `backToSale`.

## Phase 4 — Deferred (unchanged from prior plan)

Step 7 (cashier landing / IA gating) and Step 8 (extract `return/held/history` fully, delete `POSTerminal.tsx`, docs + `mem://features/pos-workstation.md`) stay on the roadmap and are executed after Steps A–E land and stabilise.

## Non-goals

- No hardware-layer changes.
- No schema / RPC / edge-function / `pos_outbox` changes.
- No changes to payment business rules (ADR 0009 invariants preserved).
- No admin-surface (Reports / Settings) visual redesign in this wave.

## Technical notes

- The URL-per-phase contract from `useTerminalUrlSync` is retained — deep links and browser back/forward stay first-class. The user's "URL changes" observation is addressed by keeping the cart + summary mounted, not by suppressing URL updates.
- `TransactionSummaryRail` was extracted with a `size` prop specifically for reuse inside Tender/Receipt/History overlays — Step C is what that prop was designed for.
- `PostPaymentSurface` stays shared between `ReceiptWorkspace` and the History overlay's inline preview — do not inline it.

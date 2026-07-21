## Scope

Three POS improvements:

1. Pre-payment stock validation with clear error messaging.
2. "Peek mode" product info panel accessible from the sale workspace.
3. Convert History from a full route redirect to a sheet that keeps the cart visible, matching the Drawer pattern.

Deferred (out of scope for this plan — call out explicitly): backorder queueing, cross-store availability, real-time WebSocket inventory push. The existing `usePOSStockSync` Realtime subscription and per-register RPC already provide near-real-time inventory; no infra changes needed.

## 1. Pre-payment stock validation

**Current gap:** `verifyCartStock` in `src/hooks/pos/usePOSStockSync.ts` exists but has **zero callers**. Payment proceeds without a final stock check, so out-of-stock items surface as a generic error from the commit RPC.

**Change:**
- In `TenderWorkspace.tsx`, before the commit RPC fires (inside the confirm handler), call `verifyCartStock(registerId, cartItems)`.
- On failure, block the commit and show a `<Dialog>` listing each offending line: `Product name — available: X, requested: Y`, plus two actions:
  - **Remove from cart** (single-click per line; calls existing cart remove intent)
  - **Adjust to available** (sets qty to the available number; disabled when available = 0)
- Also add a lightweight, non-blocking check when the user *opens* the tender workspace (mount effect) so the warning appears before they start keying an amount. Payment buttons stay disabled while any line is over-available.
- Normalize the commit RPC's stock error (`insufficient_stock` / Postgres check violation with the known code) inside `src/services/pos/*` so if the pre-check races with another till, the toast still reads `"Item X went out of stock during payment. Please remove it and try again."` instead of "something unexpected happened".

**Files touched:**
- `src/apps/pos/terminal/tender/TenderWorkspace.tsx` — pre-flight + confirm-time check + dialog.
- `src/apps/pos/terminal/tender/StockBlockerDialog.tsx` — new component.
- POS commit service (whichever wraps the RPC) — map the DB error to a human message via the existing `normalizeError` layer in `src/services/resilience`.

## 2. Product "Peek Mode"

**Change:**
- New sheet `src/apps/pos/terminal/sale/ProductPeekSheet.tsx` mounted through the existing `SheetShell` so it inherits the phase-aware auto-dismiss and cart-visible layout.
- Register a new `SheetId` `"peek"` in `useTerminalState.ts` (allowed in the `sale` and `tender` phases so cashiers can peek while on the payment screen too).
- Trigger: a "Product Info" button in `SaleActionBar.tsx` and a keyboard shortcut (`F2`, wired via existing terminal shortcut layer).
- Content: search input (SKU / barcode / name — debounced), result list, and a details panel showing:
  - Name, description, image (if present)
  - SKU, barcode(s) from `product_identifiers`
  - Unit price (from active price list) and cost hidden unless the user has the existing `products.read_cost` permission
  - Current per-register available stock via `get_available_pos_stock_for_register`
  - Per-warehouse stock via a lightweight `warehouse_stock` read (organization-scoped, RLS-guarded)
  - "Add to cart" action (respects existing cart intents; disabled when available = 0)
- Scanner integration: when the sheet is open, the shared scanner event bus routes scans into the peek input instead of the cart (existing `useScannerScope` pattern).

**Files touched (new + edits):**
- New: `src/apps/pos/terminal/sale/ProductPeekSheet.tsx`, `src/hooks/pos/useProductPeek.ts`.
- Edited: `src/apps/pos/terminal/useTerminalState.ts` (allow-list), `src/apps/pos/terminal/TerminalShell.tsx` (mount sheet), `src/apps/pos/terminal/sale/components/SaleActionBar.tsx` (button + shortcut).

## 3. History as a cart-preserving sheet

**Current:** History is `phase === "history"` and renders as a full-region workspace via `HistoryWorkspace.tsx`; the URL redirects to `/history` and the cart is hidden.

**Change:**
- Demote History from a workspace phase to a sheet using the same `SheetShell` primitive that Drawer uses.
  - Add `SheetId = "history"` (already implied by naming — verify + add allow-list entries for `sale` phase only).
  - Move `HistoryWorkspace.tsx` body into `HistorySheet.tsx` — keep the void FSM, reprint path, and `PostPaymentSurface` stacking behaviour unchanged. `PostPaymentSurface` continues to work because the sheet uses shadcn `Sheet` (portal-based), not the retired `<Dialog>`.
  - The sheet mounts on the right (`side="right"`) at width `w-full sm:max-w-3xl lg:max-w-5xl` so the cart column stays visible on ≥lg. On <sm it becomes a bottom sheet at `h-[92vh]`.
- Route change: `/pos/terminal/:id/history` continues to work — the URL sync layer (`useTerminalUrlSync`) sets `activeSheet = "history"` on load instead of switching phase. The route entry stays for shareable links.
- Remove the `history` phase from the phase enum after callers move; keep a one-release deprecation shim if any code still checks it.

**Sub-modals kept modal on purpose (`ManagerOverrideDialog`, `VoidTransactionDialog`) continue to work — they render into the same portal root.**

**Files touched:**
- New: `src/apps/pos/terminal/history/HistorySheet.tsx` (thin wrapper reusing the existing body).
- Edited: `src/apps/pos/terminal/history/HistoryWorkspace.tsx` (extract body / re-export), `src/apps/pos/terminal/useTerminalState.ts`, `src/apps/pos/terminal/useTerminalUrlSync.ts`, `src/apps/pos/terminal/TerminalShell.tsx`, `src/apps/pos/routes.tsx`.

## Cross-cutting

- **Permissions:** the peek cost/margin fields respect the existing `products.read_cost` capability; no new roles.
- **Accessibility:** all new dialogs/sheets use shadcn primitives with proper `SheetTitle` / `DialogTitle`, `Esc` closes, focus returns to trigger. Peek input has an `aria-label` and result list is keyboard-navigable.
- **Offline:** the pre-payment stock check falls back to the local reservation cache (`getReservations`) when the RPC errors with `offline`; a warning banner surfaces "Stock check unavailable — proceed at cashier discretion" instead of hard-blocking.
- **No schema changes.** No new RPCs required — everything is composed from existing endpoints (`get_available_pos_stock_for_register`, `products` read, `warehouse_stock` read).

## Verification

- `tsgo` typecheck.
- Manual walk-through against preview: (a) add a zero-stock item and try to pay — expect blocker dialog; (b) open Peek via F2 while a cart is active — expect cart still visible; (c) open History — expect cart column visible, void + reprint still work.

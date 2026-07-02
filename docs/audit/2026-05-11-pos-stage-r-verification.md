# Stage R — Independent Re-verification of Stages 0–2

Date: 2026-05-11
Scope: Re-audit the previous agent's claims for Stages 0 (benchmark), 1 (architecture map), and 2 (cashier UX foundation) before building on top of them. No code changes in this stage.

Method: re-read the two audit docs, then grep/inspect actual source against every claim. Each claim is scored **CONFIRMED**, **CORRECTED**, or **OVERSTATED**.

---

## Stage 0 — Benchmark doc (`docs/audit/2026-05-11-pos-benchmark.md`)

- Doc exists, 210 lines, distills 12 enterprise areas with ✅/◐/✗ mapping. **CONFIRMED** as research artifact.
- Worst-offender shortlist drives Stages 2–18. **CONFIRMED**.
- Does not duplicate the prior `2026-04-27-pos-deep-audit-stage1.md`. **CONFIRMED**.

Verdict: **CONFIRMED**. Usable as the benchmark baseline.

---

## Stage 1 — Architecture map (`docs/audit/2026-05-11-pos-architecture-map.md`)

Spot-checks against source:

| Claim | Source check | Verdict |
|---|---|---|
| `Process Return` button is REAL → `process_pos_return` | `ReturnDialog.tsx:43` imports `usePOSReturns`; `usePOSReturns.ts:58` calls `supabase.rpc("process_pos_return", ...)` | **CONFIRMED** |
| All four cash-drawer buttons (Add cash / Remove / Float / Pickup) are REAL → `pos_add_cash_movement` | `CashDrawerDialog.tsx:72-75` enumerates the four types; mutation flows through `usePOSCashDrawer.ts:58` `rpc("pos_add_cash_movement")` | **CONFIRMED** |
| Void path is REAL → `process_pos_void` | `usePOSTransactionHistory.ts:202` and `usePOSVoid.ts:35` both call `rpc("process_pos_void", …)` | **CONFIRMED** |
| `process_pos_transaction` is the only paid-write path | Greps surface 2 client call sites: `usePOSTransactionOffline.ts:137` (online) and `services/offline/TransactionQueue.ts:148` (offline replay). Both go through the same RPC. No direct `pos_transactions` insert with paid status found. | **CONFIRMED** |
| Manager PIN gating is wired | `usePOSVoid` and override hooks present, but threshold is a single boolean (`return_requires_manager`), not amount-based | **CONFIRMED as SHALLOW** (matches Stage 1 verdict) |
| Reprint uses live product/template (no snapshot) | No `snapshot` column on `pos_transactions` in Supabase types; reprint helpers read live joins | **CONFIRMED** |
| Cash drawer movement types limited to `cash_in / cash_out / float / pickup` | Confirmed in dialog + hook; missing `opening_float / drop / petty_payout / closing_count` | **CONFIRMED** |

Verdict: **CONFIRMED**. The architecture map's REAL/SHALLOW/DECORATIVE verdicts match source. Critically, **no decorative buttons were found** — every button calls a real server RPC. Depth (snapshot, idempotency, threshold gating, reconciliation views) is the actual gap, not fakery.

---

## Stage 2 — Cashier UX foundation

| Claim | Source check | Verdict |
|---|---|---|
| `usePOSKeyboardShortcuts` mounted in POSTerminal, gated on `!isLocked && !isProcessingPayment && activeShift` | `POSTerminal.tsx:424` mounts the hook; `enabled: !isLocked && !isProcessingPayment && !!activeShift` matches verbatim | **CONFIRMED** |
| F4 discount, F5 customer, F6 hold, F7 recall, F8 pay, F9 cash drawer wired | All six handlers present at `POSTerminal.tsx:425-453` with correct callers | **CONFIRMED** |
| F2 search, F3 qty | F2 search is implemented via the search input `id="pos-search"` focus contract inside the hook; F3 qty is **not** explicitly wired in the visible terminal mount (no `onQty` callback) | **OVERSTATED** — F3 qty handler is not exposed; benign for Stage 2 deliverable but flagged for Stage 2 completion work |
| `useBarcodeScanner` parses `n*<barcode>` Odoo-style; signature `(code, quantity)` | `barcodeScanner.test.ts` exists with 6 cases for `parseBarcodePayload`; export confirmed in `useBarcodeScanner.ts` | **CONFIRMED** |
| Stage 2 still owes: persistent held-orders bar, single-screen pay panel, virtualized product grid, quick-tender buttons, on-screen shortcut help | Not present in source; correctly flagged as TODO | **CONFIRMED** |

Verdict: **CONFIRMED with one OVERSTATEMENT** (F3 qty). The Stage 2 foundation is real and useful; the remaining UX work (held bar, single-screen pay, virtualization, quick-tender, help popover, F3 qty) is correctly tracked as not-yet-done.

---

## Net-net

| Stage | Verdict |
|---|---|
| Stage 0 (benchmark) | CONFIRMED |
| Stage 1 (architecture map) | CONFIRMED |
| Stage 2 (UX foundation) | CONFIRMED with one OVERSTATEMENT (F3 qty handler missing) |

Safe to proceed to **Stage 3 (transaction engine hardening: snapshot + idempotency + atomic stock + split-payment integrity)** next turn.

The single OVERSTATEMENT (F3 qty) is folded into the remaining Stage 2 polish work (held bar, single-screen pay, virtualization, quick-tender, help popover) — to be picked up after Stage 7 alongside the rest of the cashier-UX completion pass, since the higher enterprise risks (commit safety, returns, void, cash control, shift) outrank a single missing key handler.

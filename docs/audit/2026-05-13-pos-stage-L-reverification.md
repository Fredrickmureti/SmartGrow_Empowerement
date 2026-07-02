# POS — Stage L re-verification (zero-trust pass over K1–K11)

Date: 2026-05-13
Author: build agent (independent re-verification before Stage L code changes)

Rule: every claim from prior stages must cite a live file+line. Anything
that cannot be cited becomes a new K-item and goes back to the backlog.

---

## K1 — Returns engine UX hardening ✅ CONFIRMED

| Claim | Evidence |
|---|---|
| `usePOSReturnableQty` reads `v_pos_returnable_qty` | `src/hooks/pos/usePOSReturnableQty.ts:27,34` |
| Wired into ReturnDialog `+` cap | `src/components/pos/ReturnDialog.tsx:27,102` |
| `v_pos_returnable_qty` exists in DB types | `src/integrations/supabase/types.ts:34970` |
| REFUND watermark on reprint | `src/components/pos/ReceiptPreviewDialog.tsx:379–385` |
| `is_refund` flag plumbed through | `src/components/pos/TransactionHistoryDialog.tsx:473` |
| Server `over_return` rejection | migration `20260511084739` + `stage-4-returns.test.ts:37` |

## K2 — Void/Return/Cancel taxonomy ✅ CONFIRMED

Server invariants present in `process_pos_void` (migration `20260511031434`):
- `already_voided` → line 37
- `shift_not_open` → line 46
- `return_exists` → line 56
- `original_voided` (returns side) → `20260511084739:98`

K12 (auto-route VoidDialog → ReturnDialog on `shift_not_open`) remains open
— not regressed, just not implemented.

## K3–K9 — backlog ⏸ NOT YET STARTED

No code claims to verify. Carried forward.

## K10 — `pos_error_log` / `POSErrorBoundary` / `posErrorChannel` ✅ CONFIRMED

- Boundary mounted in `src/apps/pos/routes.tsx:33–35`
- Class defined in `src/components/pos/POSErrorBoundary.tsx:31`
- Stage J doc previously marked this FAIL; that verdict was wrong.

## K11 — `HeldOrdersBar` ✅ CONFIRMED

- Imported `src/pages/pos/POSTerminal.tsx:71`
- Rendered `src/pages/pos/POSTerminal.tsx:1254`

## Drawer / cash-control re-verification

| Claim | Evidence | Verdict |
|---|---|---|
| `useDrawerPolicy` is the sole chokepoint | `src/hooks/pos/useDrawerPolicy.ts`, guarded by `no-duplicate-drawer-policy.test.ts` | ✅ |
| Cash-only kick is default | defaults `auto_open_drawer_on_cash=true`, `auto_open_drawer_on_non_cash=false` (hook L55–56; register form L45–46) | ✅ |
| Sale path consumes policy | `POSTerminal.tsx:701` `drawerPolicy.shouldKickDrawer(...)` | ✅ |
| `confirm_before_drawer_open` exists but unused at terminal | hook L56, form L48,73,120,382 — **no consumer in POSTerminal** | ⚠ Gap → fixed in L1 |
| Reprint/return/void path through policy | not present — sale path only | ⚠ Gap → fixed in L1 |
| Printer `auto_kick_on_print` capability surfaced | `src/components/pos/DeviceRegistryCard.tsx:77` (warn only) | ⚠ Soft → L1 hardens to block-save |
| `pos_cash_movements` RPC-only | arch guard `no-client-pos-cash-writes.test.ts` | ✅ |
| `pos_drawer_events` + RPC | migrations `20260511093529`, `20260511100658` | ✅ |
| Manager override matrix | `assert_manager_override` used in `20260511084739:200`; table `pos_manager_overrides` | ✅ |
| Cash-movement reason presets / denomination quick-count (Stage J) | `CashDrawerDialog.tsx`, `CashDenominationCounter.tsx`, `DenominationSettingsCard.tsx` | ✅ |

## Net verdict

All previously-claimed K1, K2, K10, K11 work is real and wired.
Two specific gaps the user surfaced explicitly are real and unaddressed:

1. **`confirm_before_drawer_open` setting is dead weight** — register has the
   column, hook exports it, no UI consumes it. Stage L1 fixes.
2. **Reprint / return / void do not route through `useDrawerPolicy`** — the
   drawer fires (or doesn't) based on whatever the printer firmware does,
   not on the original tender mix. Stage L1 fixes.
3. **Cash movement always asks for a typed reason** — fatigue gap, no
   threshold gating. Stage L2 fixes.

Stage L proceeds with these three as the work items. No K1–K11 rework needed.

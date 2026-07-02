# Inventory FEFO closeout — Phase 1 (Lot trigger hardening)

Date: 2026-05-30
Author: independent re-audit, second pass
Plan: `.lovable/plan.md` (approved this session)

## What shipped

Migration `Phase 1 — Lot trigger hardening` rewrites two SECURITY DEFINER
functions:

1. `public._maintain_warehouse_stock_lots()` — AFTER INSERT trigger on
   `stock_movements`. Previously only classified the explicit `*_in` / `*_out`
   movement tokens. Atomic RPCs that emit the legacy generic tokens
   (`'adjustment'`, `'transfer'`) with a signed quantity were silently skipped
   on lot-tracked products, causing `warehouse_stock_lots` to diverge from
   `warehouse_stock` (Gap B2 in the re-audit plan).

   The trigger now falls back to `sign(NEW.quantity)` for those two legacy
   tokens. Explicit `*_in` / `*_out` tokens behave exactly as before. Lot
   discipline (`is_lot_tracked` outbound must carry `lot_number`) and lot
   master auto-creation on first inbound are unchanged.

2. `public.rebuild_warehouse_stock_lots(p_business_id uuid)` — replay routine.
   The SUM-CASE that recomputes per-lot balances from movement history now
   includes the same `('adjustment','transfer') → sm.quantity` branch, so a
   rebuild produces the same result as the live trigger.

## Why this is safe

- Pure rewrite of two function bodies; no schema change, no new
  permissions, no policy change.
- Products with `is_lot_tracked = false` are untouched — the trigger still
  returns early when `lot_number IS NULL`.
- Explicit `*_in` / `*_out` tokens classify identically to the prior version.
- The lot enforcement (raise on outbound without `lot_number` for lot-tracked
  products) is preserved verbatim.

## Verification

```sql
-- Drift view empty across all lot-tracked products
SELECT count(*) FROM public.lot_quant_drift_view;          -- → 0

-- Function reflects the new sign-based classification
SELECT pg_get_functiondef(p.oid) ~ 'NEW\.quantity > 0' AS uses_sign
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname = '_maintain_warehouse_stock_lots';        -- → true
```

Both passed in the live DB at migration time.

## What's still open (next phases)

- Phase 2 — invoice outbound lot flow (SO/estimate/proforma → invoice RPCs).
- Phase 3 — POS outbound lot flow (`process_pos_transaction`, `process_pos_return`).
- Phase 4 — switch the positive lot-tracked branch of
  `approve_stock_adjustment_atomic` to write `'adjustment_in'` (belt-and-
  suspenders alongside Phase 1).
- Phases 5–8 per `.lovable/plan.md`.

## Risk notes for downstream phases

When Phase 4 switches the RPC to `'adjustment_in'`, this Phase 1 fix
guarantees rows already emitted under the legacy `'adjustment'` token
continue to reconcile correctly. The two phases are intentionally
independent — Phase 1 alone is sufficient to stop new drift; Phase 4 is
clean-up that brings the RPC into line with the explicit-token convention
used by everything else.

---
name: Landed cost across warehouses
description: Cost layers are warehouse-scoped, so landed cost apply/reverse is warehouse-correct without a warehouse argument; reversal splits inventory vs COGS
type: feature
---
`inventory_apply_cost_revaluation` / `inventory_reverse_cost_revaluation` and
`landed_cost_reverse_voucher` take no warehouse argument **by design**. They
operate on `cost_layers`, which are warehouse-scoped, and trace descendants
through `cost_layer_lineage`, so a transfer's destination layer is found in
the right warehouse automatically. Do not "fix" this by threading a
warehouse parameter — it is redundant state.

Reversal unwinds against `qty_remaining_at_apply`, so stock consumed after
posting is credited to COGS, not inventory. Proven live 2026-08-16 with
LCV-2026-00005: Dr clearing 2,000 / Cr inventory 1,815.03 / Cr COGS 184.97.

Known and accepted: when a transfer merges several parent layers into one
destination layer, the uplift spreads across every unit in the merged layer.
The amount attributed to the receipt stays exact; only the per-unit spread
follows the merge.

Ratchet: `supabase/tests/landed_cost_warehouse_split_test.sql`.
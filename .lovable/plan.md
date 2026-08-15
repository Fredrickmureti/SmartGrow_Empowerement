
## Execution log — sell side (steps 1–3 done)

| Event | Invoice line | Ledger movement | On-hand after |
|---|---|---|---|
| Sell 17 kg loose | 17 base / disp 17 / no pack / KG | −17, disp −17, f1 | 483 |
| Sell 1 × 50 kg Bag | 50 base / disp 1 / "50 kg Bag" / f50 / KG | −50, disp **−50**, pack **loose**, **f1** | 433 |
| 2, 1, 5, 25 kg loose | correct in KG each | correct | 400 |

500 − 17 − 50 − 2 − 1 − 5 − 25 = 400 exactly, across `stock_quants`,
`warehouse_stock` and `products.stock_quantity`. No kg→ea substitution anywhere
on the invoice/delivery line path.

### Defects found (to fix in step 8)

1. **`set_invoice_status_atomic` is broken at runtime** — it calls
   `public.user_has_business_access(v_inv.business_id)` (1 arg) but the function
   is `user_has_business_access(_user_id uuid, _business_id uuid)`. Every call
   fails with SQLSTATE 42883. Layer: database RPC. Not a UoM bug, but it blocks
   invoice status changes from the Sales UI.
2. **Pack provenance is dropped when the delivery writes the ledger** —
   `delivery_note_items` correctly carries `packaging_id`, `display_quantity` 1,
   `uom_snapshot_pack_name` "50 kg Bag", factor 50, but the movement written by
   `complete_delivery_atomic` stamps `display_quantity` −50, pack NULL, factor 1.
   The base quantity is right; the commercial meaning ("1 Bag") is lost at the
   ledger. Same shape as the receipt movement (500 kg received as 10 bags,
   stamped loose). Layer: `complete_delivery_atomic` movement writer.

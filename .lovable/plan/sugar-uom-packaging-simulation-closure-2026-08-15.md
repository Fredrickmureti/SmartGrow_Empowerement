# Sugar simulation — final execution record and verdict

All events below were executed against the live database through the real
application paths (product form RPC, receiving, sales/delivery, POS shift →
payment session → tender → commit). Nothing was fixed during the run.

## 1. Configuration

| Concern | Value |
|---|---|
| Product | Sugar, SKU SUGAR, type `product`, `track_inventory` true |
| Base UoM | KG (Weight, `factor_to_reference` 1) |
| Packaging | "50 kg Bag", `qty_in_base_uom` 50 |
| Price | 150 / KG |

## 2. Events executed and ledger outcome

| # | Event | Path | Line (qty / display / pack / factor / base) | Movement | On hand |
|---|---|---|---|---|---|
| 1 | Receive 10 × 50 kg | goods receipt | 500 / 10 / 50 kg Bag / 50 / KG | +500, **display 500, pack NULL, factor 1** | 500 |
| 2 | Sell 17 kg loose | invoice → delivery | 17 / 17 / — / 1 / KG | −17, correct | 483 |
| 3 | Sell 1 × 50 kg Bag | invoice → delivery | 50 / 1 / 50 kg Bag / 50 / KG | −50, **display −50, pack NULL, factor 1** | 433 |
| 4 | Sell 2 / 1 / 5 / 25 kg | invoice → delivery | correct in KG each | correct | 400 |
| 5 | POS sell 2 kg loose | POS commit | 2 / 2 / — / 1 / KG | −2, display −2, KG | 398 |
| 6 | POS sell 1 × 50 kg Bag | POS commit | 50 / 1 / 50 kg Bag / 50 / KG | −50, **display −1, pack "50 kg Bag", factor 50** | 348 |

`products.stock_quantity`, `warehouse_stock`, `stock_quants` and the sum of
`stock_movements` all read **348.000** — arithmetically exact. No kg→ea
substitution anywhere, on any path.

### Generic proof (same paths, other dimensions)

| Product | Base | Event | Result |
|---|---|---|---|
| Cooking Oil | L (Volume) | POS 2.5 L loose | −2.5 L, snapshot L |
| Cooking Oil | L | POS 1 × 20 L Drum | line 20 / disp 1 / factor 20; movement −20, disp −1, pack kept |
| Cable | M (Length) | POS 2.5 m | −2.5 M |
| Chair | PCE (Count) | POS 2.5 chairs | **ACCEPTED** — on hand now 7.5 pieces |

## 3. Documents

- Invoice snapshot (bag sale): `display_quantity` 1, `packaging_label`
  "50 kg Bag", `pack_size` 50, `base_uom_label` KG, unit price rebased to
  7 500 / bag → PDF cell reads **"1 50 kg Bag (50 KG)"**, Qty × Price = Amount.
- Invoice snapshot (loose): **"17 KG"**, unit price 150.
- POS receipt snapshots: **"2 KG"** and **"1 50 kg Bag (50 KG)"**.
- Commercial meaning is preserved end-to-end on the printed artefacts.

## 4. Canonical vs derived

| Field | Status |
|---|---|
| `products.base_uom_id` | canonical, immutable after first transaction |
| `product_packaging.qty_in_base_uom` | canonical for arithmetic |
| line `quantity` | canonical (base units) |
| line `display_quantity`, `uom_snapshot_pack_name/_factor/_base_code` | frozen at write; presentation truth for history |
| `stock_movements.quantity` | canonical; `display_quantity`/snapshot columns are frozen presentation |
| `warehouse_stock`, `stock_quants`, `products.stock_quantity` | derived rollups |
| `document_records.snapshot`, `pos_receipt_snapshots.payload` | frozen copies |

## 5. Defects found (not fixed)

1. **Ledger pack provenance dropped on the receiving and delivery writers.**
   `complete_delivery_atomic` and the goods-receipt movement writer stamp
   `display_quantity` = base quantity, pack name NULL, factor 1, even though
   the source line carries the pack. The POS writer does this correctly, which
   proves it is a per-writer omission, not an architectural limit. Impact:
   stock-card / movement reports show "50" instead of "1 Bag" for purchase and
   delivery movements; valuation and balances unaffected.
2. **`set_invoice_status_atomic` is broken at runtime.** It calls
   `public.user_has_business_access(v_inv.business_id)` (1 arg) against a
   2-arg function → SQLSTATE 42883 on every call, blocking invoice status
   changes from the Sales UI.
3. **No integrality guard on countable base UoMs.** POS accepted 2.5 chairs;
   on-hand is now 7.5 PCE. Weight/volume/length must allow fractions, Count
   must not. Nothing in the line, RPC or POS path enforces this.
4. Minor: `create_product_with_opening_stock_atomic` silently ignores an
   opening line whose quantity key is not `quantity_adjustment` — the product
   is created with no stock and no warning.

## 6. Architecture verdict

The model — base UoM canonical, packaging as a factor, frozen per-line
snapshot, derived rollups — is correct and genuinely dimension-agnostic:
weight, volume, length and count all flow through the identical code with no
special casing. The failures are localised omissions in two movement writers,
one wrong function call, and a missing count-integrality rule — not a design
flaw. Remediation would be four small, independent changes, each with a guard
test; none require reshaping the UoM model.

---

## Closure — 2026-08-15

Diagnostic run (steps A–F) complete; remediation (step G) shipped.

Final ledger state for Sugar: 500 received − 100 sold (17 + 50 + 2 + 1 + 5 + 25)
− 52 POS (2 loose + 1 × 50 kg Bag) = **348 kg**, consistent across
`products.stock_quantity`, `warehouse_stock` and `stock_quants`.

### Verdict
The quantity model is sound and dimension-agnostic: product → base UoM →
packaging → line (`display_quantity` + `packaging_id`, canonical base quantity)
→ ledger snapshot. Weight (KG), volume (L), length (M) and count (PCE) all ran
through the same path with no `kg → ea` substitution anywhere. The failures were
localised, not architectural.

### Defects fixed
1. **`set_invoice_status_atomic`** called `user_has_business_access/1` against a
   `/2` signature — every status change failed with 42883. Now passes the acting
   user.
2. **Pack provenance lost on the ledger.** Root cause: `_backfill_movement_packaging`
   ran AFTER INSERT, so `_stamp_ledger_uom_snapshot` had already frozen
   pack_name NULL / factor 1 / display = base quantity. A 1-bag delivery read as
   "−50", a 10-bag receipt as "500". It is now a BEFORE INSERT trigger that
   assigns `NEW.source_packaging_id` / `NEW.source_uom_id`, so every writer
   (delivery, goods receipt, adjustment, transfer, returns, credit note, bill,
   POS) freezes the correct commercial snapshot from one place.
3. **No integrality guard on countable units** — 2.5 chairs posted. New
   `trg_enforce_movement_uom_granularity` derives the step from
   `units_of_measure.rounding`, so PCE/EA reject fractions while KG/L/M keep
   accepting 2.5.
4. **Opening stock silently ignored mis-keyed lines** (`quantity` instead of
   `quantity_adjustment`) and created the product with zero stock. Now raises
   `OPENING_STOCK_BAD_PAYLOAD`.

Guard test: `supabase/tests/uom_packaging_ledger_guards_test.sql` (all
assertions verified green against the live database).

### Known, deliberately not changed
Historical movements written before the fix keep their original (loose)
snapshots — the ledger is immutable by design and is not rewritten.

# Landed Cost — Phase B.2: goods receipt reversal and return to supplier

## The question

A landed cost voucher capitalises charges into the cost layers created by a
goods receipt. What happens when that receipt is later reversed, or the goods
are returned to the supplier?

Answer before this change: nothing. Neither `void_goods_receipt_atomic` nor any
`purchase_return_*` command mentioned landed cost. The capitalised charges would
have stayed in inventory value after the stock left — silent valuation drift and
an overstated Landed Cost Clearing position.

## Decision: block, do not auto-reverse

A posted landed cost voucher is an approved accounting document with its own
governance route (`landed_cost.reverse`, self-approval guard, reversal reason).
Unwinding it as a side effect of a warehouse action would bypass all of that.
The receipt path therefore **refuses** and names the required prior step, and the
reversal wizard surfaces `reverse_landed_cost` as the recommended operation.

## Implementation (canonical, no new engines)

- `landed_cost_receipt_encumbrance(uuid)` — the single authority for "does this
  receipt still carry landed cost", reading `landed_cost_vouchers`,
  `landed_cost_voucher_receipts` and `landed_cost_allocations`. Excludes
  `draft`, `cancelled` and `reversed`. `landed_cost_receipt_block_reason(uuid)`
  renders the operator sentence; `landed_cost_assert_receipt_unencumbered(uuid,
  text)` is the hard guard (`23514`, `HINT = LANDED_COST_ENCUMBERED`).
- `resolve_reversal_intent` is **annotated, not forked**:
  `_landed_cost_annotate_reversal_intent` decorates the goods_receipt verdict
  produced by `resolve_reversal_intent_finance` — flipping `goods_return` to
  disallowed with the reason, adding the `landed_cost_encumbered` blocker and the
  `reverse_landed_cost` operation. Landed Cost stays a consumer of the finance
  authority; the 450-line intent matrix is not duplicated.
- `void_goods_receipt_atomic` inherits the block for free: it already calls
  `assert_can_reverse('goods_receipt', …, 'goods_return')`, which consults the
  intent authority.
- `purchase_return_create` asserts the guard for goods returns, and
  `purchase_return_dispatch` re-asserts it at the moment stock actually leaves
  (a voucher can be posted between drafting and dispatch).

## Defect found: purchase returns never released stock value

`purchase_return_dispatch` inserted its stock movements with
`movement_type = 'return'`. That value is not in
`stock_movements_movement_type_check`, so the insert could not succeed at all,
and it is matched by neither branch of `_maintain_cost_layers` — so even if it
had, no cost layer would have been consumed and inventory value would have
stayed behind after the goods went back to the supplier.

Fixed to `vendor_return`, which is permitted by the vocabulary and is consumed
by the outbound layer branch at the layer's own unit cost — i.e. including any
capitalised landed cost. AVCO is then re-derived per product through
`inventory_sync_avco_from_layers` (a registered valuation writer, ADR 0078).

## Verification (live, rolled back)

With the live voucher temporarily flipped to `posted`:

```
reversed voucher -> encumbered=false
posted   voucher -> encumbered=true  posted_count=1
reason: Landed cost LCV-2026-00001 has been posted against this receipt and
        51.50 of charges are capitalised into the stock value. Reverse the
        landed cost first, otherwise the charges stay in inventory after the
        goods leave.
assert blocked=true
intent recommended=reverse_landed_cost  blockers=["landed_cost_encumbered"]
goods_return allowed=false
operations=goods_return, vendor_credit_note, reverse_landed_cost
```

The transaction was aborted; the voucher remains `reversed`.

Ratchet: `supabase/tests/landed_cost_receipt_reversal_guard_test.sql`.

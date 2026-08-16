# Landed Cost — Phase B item 2: crediting a capitalised freight bill

Phase B closed the receipt side (a goods receipt carrying posted landed cost
cannot be returned). The mirror case on the **liability** side was open: nothing
stopped a vendor credit note against the freight/duty bill whose charges had
already been capitalised into inventory.

## The defect

`landed_cost_post_voucher` debits Inventory/COGS and credits **Landed Cost
Clearing**; the freight bill debited that same clearing account. A vendor credit
note against the bill credits the clearing account a second time while the
capitalised charge stays inside the stock value. Result: clearing account
permanently off by the credited amount, inventory permanently overstated, and no
trace of why. `resolve_reversal_intent` recommended `vendor_credit_note` as the
*preferred* correction for a paid or period-closed bill, so the wrong path was
also the signposted one.

## Decision

Block, never auto-reverse — the same decision as the receipt guard. A posted
voucher is an approved accounting document with its own governance route
(`landed_cost.reverse`, reason mandatory, self-approval guarded). The operator
reverses the landed cost, then credits the supplier.

## What was added

One authority over the existing allocation truth, no second engine:

| Function | Role |
| --- | --- |
| `landed_cost_bill_encumbrance(bill)` | live vouchers reaching the bill through `landed_cost_vouchers.source_bill_id` **or** any `landed_cost_components.source_bill_id`; draft/cancelled/reversed encumber nothing |
| `landed_cost_bill_block_reason(bill)` | the operator-facing sentence, naming the voucher and the amount sitting in stock value |
| `landed_cost_assert_bill_unencumbered(bill)` | the refusal (`23514`, hint `LANDED_COST_ENCUMBERED`); `service_role` only, not a client RPC |

Enforcement is a single `BEFORE INSERT OR UPDATE OF bill_id, accounting_status`
trigger on `vendor_credit_notes`, so it covers draft creation, re-pointing at
another bill, and the moment the note posts — every write path, including the
approval mirror, rather than one hand-patched RPC.

`_landed_cost_annotate_reversal_intent` now covers `bill` as well as
`goods_receipt`: it marks `vendor_credit_note` and `void` disallowed with the
reason, appends a `reverse_landed_cost` route carrying the voucher payload, adds
the `landed_cost_encumbered` blocker, and switches the recommendation. It still
annotates finance's verdict and never forks it — `resolve_reversal_intent`
remains a single overload delegating to `resolve_reversal_intent_finance`.

## Verification (live)

- four new functions, one overload each; dispatcher still one overload
- guard trigger present with the expected BEFORE/ROW/INSERT/UPDATE shape
- assertion not executable by `anon`/`authenticated`; the reason is readable by
  the app so the UI can explain the block
- annotator is read-only (no inserts/updates) and covers both scopes
- live-data invariant: zero credit notes sit on a bill with a live voucher, so
  the guard introduces no false positives on existing data

## Ratchet

`supabase/tests/landed_cost_bill_encumbrance_test.sql` locks in the single
authority, both linkage paths, the trigger shape, the draft-and-post double
check, the privilege boundary, the annotate-never-fork rule, and the live-data
invariant.

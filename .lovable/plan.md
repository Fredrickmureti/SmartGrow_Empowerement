# POS Wave — Transaction Engine & Canonical Domain Consumer Audit

Authoritative engineering record. Continue at the first phase that is not ✅.
Do not repeat completed investigation. Prior wave record:
`.lovable/plan/pos-wave-transaction-engine-canonical-domain-consumer-audit-2026-08-16.md`.

## Phase status

| # | Phase | Verdict | State |
|---|---|---|---|
| 0 | POS topology & critical path | ✅ | map in the archived plan |
| 1 | Product consumption / read seam | ✅ | **closed this pass — F10 fixed (catalogue RPC executes again)** |
| 2 | UoM & packaging contract | ✅ | packaging/display UoM on the line, server converts |
| 3 | Inventory availability | ✅ | `pos_register_stock_scope` + branch-grained `stock_quants` |
| 4 | Pricing / tax authority | ✅ | `pos_resolve_line` + `pos_quote_cart` |
| 4a | POS RPC exposure | ✅ | anon/PUBLIC EXECUTE revoked wave-wide |
| 4b | Commit idempotency race | ✅ | duplicate submit collapses to replay |
| 5 | Transaction state machine | ✅ | table orders server-priced |
| 6 | Server-side money authority | ✅ | retail + restaurant quote server-side |
| 7 | Payment integrity | ✅ | server re-derives payable total at commit |
| 8 | Concurrency & idempotency (multi-terminal) | ✅ | **closed this pass — F6 fixed** (hold/recall/cancel, split bills, merge/transfer/move) |
| 9 | Offline / retry behaviour | ⚠ | **active — next** |
| 10-15 | Returns/void, printing, events, finance, audit, reporting | — | not started |

## F10 — catalogue RPC return-type mismatch ❌→✅ (Phase 1, fixed this pass)

- **Evidence.** `list_products_with_branch_stock` declared
  `RETURNS TABLE(… etims_tax_code text …)` while `RETURN QUERY` selected
  `tax_rates.etims_tax_code`, which is `character varying`. plpgsql demands an
  exact row-type match, so *every* call raised
  "structure of query does not match function result type" — no tenant, branch
  or data condition could produce a product. Introduced when the eTIMS columns
  were added to the seam.
- **Why it matters.** POS had no catalogue at all; the previous pass's
  "empty grid = stale branch id" diagnosis was wrong (its error-surfacing work
  is what exposed the real fault).
- **Fix.** `CREATE OR REPLACE` with the identical body and explicit `::text`
  casts on every text-declared column (`p.name/description/sku/image_url/
  plu_code`, `bu.code/name`, `su.code/name`, `pc.name`, `tr.name`,
  `tr.etims_tax_code`) — signature unchanged, so no overload risk. Grants
  re-asserted: `authenticated` + `service_role`, revoked from `PUBLIC`/`anon`.
- **Class sweep.** Checked every other RPC POS reads through: `pos_resolve_scan`,
  `pos_resolve_line`, `pos_quote_cart` return `jsonb` (immune);
  `resolve_stock_availability_batch`, `get_available_pos_stock_for_register[_batch]`
  return only uuid/numeric; `resolve_product_identity`'s text columns come from
  `products.name/sku`, `product_packaging.name`, `product_identifiers.code`,
  all `text` in the live schema. No other drift.
- **Guard.** `supabase/tests/pos_product_read_seam_test.sql` — single overload,
  frozen signature, all twelve explicit casts present, anon denied /
  authenticated allowed, business-access gate (42501) intact.
- **Residual verification.** End-to-end confirmation in a signed-in terminal
  could not be run here (this project uses an external, unmanaged auth
  provider, so no browser session can be minted, and the SQL runner role has no
  EXECUTE on the locked-down POS RPCs). Type match is guaranteed by
  construction; the operator should confirm the grid renders products.

## Open findings

### F6 — held / split / merge / transfer paths ❌→✅ (Phase 8, closed this pass)

**Evidence found**
- `pos_table_transfers.business_id` is NOT NULL, but `merge_table_orders` and
  `transfer_table_items` inserted their audit row without it — **both RPCs
  failed at every call**. Table merge and item transfer were dead code paths.
- Two `transfer_table_items` overloads existed (`…jsonb, text, uuid` and
  `…jsonb, uuid, text`). Named-argument calls were ambiguous, and the older
  overload copied the **full** `tax_amount`/`line_total` onto the target while
  leaving the source line unchanged — money duplication on a partial transfer.
- Split bills were fully client-authoritative: the browser computed the equal
  split, wrote `amount` directly, and `markPortionPaid` was an unguarded
  `UPDATE` — two terminals could both "pay" the same portion.
- Holding a sale was a raw client `INSERT` carrying the browser's `subtotal`;
  cancel was an unguarded `UPDATE` that could cancel an order another terminal
  had already recalled.
- RLS on split/transfer tables was org-wide `is_org_member … FOR ALL`: no
  business/branch scoping and full client write.

**Fixes (2 migrations)**
- New RPCs: `hold_pos_transaction` (re-prices via `pos_quote_cart`; server
  stores subtotal + full quote in `tax_snapshot`), `cancel_pos_held_transaction`
  (status-guarded), `create_pos_split_bill`, `assign_pos_split_item`
  (rejects over-assignment beyond the line quantity), `remove_pos_split_item`,
  `pay_pos_split_portion` (row-locked; second payer gets
  `{success:false, conflict:true, error:'portion_already_paid'}`),
  `cancel_pos_split_bill`, `pos_recalc_split_portion`, `move_pos_table_session`
  (target-occupied + version guarded).
- `merge_table_orders` / `transfer_table_items` rewritten: business_id on the
  audit row, `user_can_access_business` + `assert_pos_caller_branch_access` on
  both sessions, cross-business denied, scope derived from the session (not the
  client-supplied org id), optional `p_expected_source_version` /
  `p_expected_target_version` returning `conflict: true`, proportional
  tax/total split, item re-checked against the source order under lock.
  Stale ambiguous overload dropped.
- RLS/grants: split bills, portions, items, table transfers and transfer items
  are now SELECT-only for `authenticated`, scoped by business (+branch where
  the column exists); INSERT/UPDATE/DELETE revoked — all writes go through the
  SECURITY DEFINER RPCs. Every new routine revoked from `PUBLIC`/`anon`.
- Client: `usePOSHeldTransactions`, `useBillSplitting`, `useTableTransfer`
  rewritten to call the RPCs; conflict responses surface as typed
  `SplitBillConflictError` / `TableTransferConflictError` with operator copy.
  Client split math removed (a clearly-labelled UI preview remains in
  `BillSplitDialog` before the split exists server-side).

**Guard.** `src/test/architecture/pos-multi-terminal-concurrency.test.ts`
(10 assertions) — all RPCs exist and are anon-revoked, hold re-quotes, no
client writes to held/split/transfer tables, portion pay is lock+conflict,
merge/transfer/move are version- and access-guarded, overload dropped,
table write grants revoked. Passes, as do the Phase 1/4/5 guards.

**Residual verification.** Same limitation as F10: no browser session can be
minted (external auth provider) and the SQL runner has no EXECUTE on the
locked-down RPCs, so an end-to-end two-terminal race was not exercised live.
Correctness rests on row locks + status/version guards proven by construction.
Operator should smoke-test: hold→recall, split→pay one portion twice from two
tabs, merge two tables, partial item transfer.

**Deferred out of Phase 8 (small, tracked):** shift close concurrent with an
in-flight commit — `close_pos_shift` was not touched this pass; fold into
Phase 9 (offline/retry) since both concern in-flight work at a boundary.

### Carried forward (non-blocking)
- Card terminal path: `pos-card-fsm.test.ts` failure is pre-existing, belongs to
  the card-driver seam (fold into Phase 10 reversal work).
- No "resume this payment" affordance after a payment timeout — Phase 9.

## Working rules for this wave
- One phase at a time: implement → verify against the live DB → record verdict → next.
- No POS-local Product model, UoM converter, inventory calculator or barcode logic.
- Browser is never authoritative for identity, quantity conversion, price, tax, totals or stock.
- Any `RETURNS TABLE` seam must cast source columns to the declared types — a
  varchar/text drift is invisible at deploy and fatal at every call (F10).
- Every SECURITY DEFINER routine added must be revoked from `PUBLIC`/`anon` in the same migration.
- Finance stays out of scope; POS → Finance dependencies collect under Phase 13.

## Known unrelated failures (do not chase)
Repo-wide `vitest src/test` has ~206 pre-existing failures across 123 files
(hardware transport mocks, card FSM, etc.), none in the product-read,
table-order or commit paths.

## Instructions for the next agent
1. **Verify Phase 8 first.** Run
   `npx vitest run src/test/architecture/pos-multi-terminal-concurrency.test.ts`
   and confirm against the live DB that: `pos_table_transfers` inserts carry
   `business_id`; only one `transfer_table_items` overload exists; split/transfer
   tables have no INSERT/UPDATE/DELETE grant to `authenticated`; every Phase 8
   routine is revoked from `PUBLIC`/`anon`. Then smoke-test hold→recall, a
   double-pay of one split portion from two tabs (second must report a
   conflict), a table merge and a partial item transfer.
2. **Then resume at Phase 9 (offline / retry behaviour)** — do not jump ahead.
   Include the two carried items: a "resume this payment" affordance after a
   payment timeout, and shift close racing an in-flight commit
   (`close_pos_shift`).
3. Keep the working rules above: no client money math, no POS-local domain
   logic, every new SECURITY DEFINER routine revoked from `PUBLIC`/`anon`,
   every `RETURNS TABLE` seam explicitly cast, one phase closed at a time with
   its own regression guard, and update this file as each phase closes.

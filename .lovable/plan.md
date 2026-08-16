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
| 9 | Offline / retry behaviour | ⚠ | **active — DB seam landed & verified; client items 1–4 pending** |

## Phase 9 — offline / retry behaviour ⚠ (active)

**Verified this pass (independent re-check of the previous agent's claims — all four DB claims are TRUE):**
- `pos_register_open_payment_sessions` — exists, SECURITY DEFINER, anon/PUBLIC EXECUTE revoked.
- `pos_till_close_blockers` — exists, SECURITY DEFINER, anon/PUBLIC revoked.
- `trg_pos_till_close_payment_guard` — attached to `public.pos_shifts`.
- `pos_payment_session_commit` — contains the `shift_closed` guard, and it sits
  *after* the apply-log replay branch (apply-log at char 305, `shift_closed` at 2696),
  so an offline retry of an already-committed sale still returns its cached envelope.
- Naming note confirmed: the DDL event trigger `_reject_country_named_function`
  rejects any routine name containing `shif` (SHIF statutory token) → `*_till_*` naming.

**Not done (client side) — remaining Phase 9 work:**
1. `src/components/pos/CloseShiftDialog.tsx` still calls `can_close_pos_shift`
   (line ~82); the new `open_payment_sessions` blocker is never shown, so the cashier
   only meets the DB trigger error at submit time.
2. `src/services/offline/TransactionQueue.ts` — `RETRY_DELAY_MS` (5000) declared but
   unused; `syncAll` uses a flat 100 ms inter-drain delay and every failure burns all
   5 attempts. No error classification: `shift_closed` / check-violation are permanent
   and must fail fast.
3. No `PaymentResumeBanner` — nothing consumes `pos_register_open_payment_sessions`,
   so a cashier who reloads mid-payment has no resume affordance.
4. No guard test for any of the above; plan.md carried no Phase 9 record.

## Next steps (this pass — close Phase 9, then Phase 10)

1. **CloseShiftDialog → `pos_till_close_blockers`.** Swap the gate RPC, render the
   `open_payment_sessions` reason (count + amount tendered) as a blocking row with
   operator copy. No money math client-side.
2. **TransactionQueue retry policy.** Use `RETRY_DELAY_MS` as the base for exponential
   backoff with jitter between drains; classify errors — `shift_closed`,
   `check_violation`, access denied (42501) and explicit business rejections are
   permanent → `failed` immediately; transport/5xx/offline are transient → backoff to
   `MAX_RETRY_ATTEMPTS`. Replay stays idempotent (queued.id remains the key; the
   apply-log already collapses replays).
3. **PaymentResumeBanner.** New `src/components/pos/PaymentResumeBanner.tsx` backed by
   `pos_register_open_payment_sessions`, mounted in the terminal sale surface: lists
   in-flight sessions with allocated/remaining, offers resume or cancel (existing
   `pos_payment_session_cancel`, which already refuses to discard captured non-cash
   money). Read-only + existing RPCs only.
4. **Guards.** `src/test/architecture/pos-offline-retry-and-resume.test.ts` (no
   `can_close_pos_shift` left in POS components, backoff + permanent-error
   classification present, banner reads only the canonical RPC, no new client writes to
   session tables) and `supabase/tests/pos_till_close_guard_test.sql` (four DB objects,
   trigger attachment, anon revocation, `shift_closed` check after the replay branch).
5. Record the Phase 9 verdict here, then start **Phase 10 — returns / void / reversal**
   (carry the pre-existing `pos-card-fsm.test.ts` failure into that phase).

Out of scope, unchanged: UI redesign, Finance internals, printing subsystem.
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

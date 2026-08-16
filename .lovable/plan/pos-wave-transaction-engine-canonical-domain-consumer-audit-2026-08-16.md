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
| 4 | Pricing / tax authority | ✅ | `pos_resolve_line` + `pos_quote_cart` — **live defect F11 found & fixed (see below)** |
| 4a | POS RPC exposure | ✅ | anon/PUBLIC EXECUTE revoked wave-wide |
| 4b | Commit idempotency race | ✅ | duplicate submit collapses to replay |
| 5 | Transaction state machine | ✅ | table orders server-priced |
| 6 | Server-side money authority | ✅ | retail + restaurant quote server-side |
| 7 | Payment integrity | ✅ | server re-derives payable total at commit |
| 8 | Concurrency & idempotency (multi-terminal) | ✅ | **closed this pass — F6 fixed** (hold/recall/cancel, split bills, merge/transfer/move) |
| 9 | Offline / retry behaviour | ✅ | **closed this pass — DB seam + all four client items landed** |
| 10 | Returns / void / reversal | — | **next** |

## F11 — the till could not price anything: untyped NULLs in the tax call ❌ → fixed

**Symptom.** Add a product, press Pay → "Prices could not be confirmed with the server.
Payment is blocked." Console shows `POST .../rpc/pos_quote_cart 404`.

**Trace (no assumption — the response body named it).**
The 404 was not a missing route or a stale PostgREST schema cache. An anonymous probe of
`pos_quote_cart` returned `42501 permission denied`, proving the function was in the cache
and correctly locked down. The authenticated browser call's response body was:

```
42883  function public.resolve_sales_line_tax(uuid, uuid, uuid, date, unknown, text)
       does not exist
```

`pos_quote_cart` → `pos_resolve_line` → `resolve_sales_line_tax`. The resolver call read:

```sql
public.resolve_sales_line_tax(
  p_business_id, p_product_id, p_contact_id, COALESCE(p_at, CURRENT_DATE),
  NULL, CASE WHEN p_product_id IS NULL THEN NULL ELSE NULL END);
```

Argument 5 is a bare `NULL` → type `unknown`; argument 6 is an all-NULL `CASE` → Postgres
types it `text`. The real signature is `(uuid,uuid,uuid,date,uuid,numeric)` and there is no
implicit `text → numeric` cast, so overload resolution failed. PostgREST maps 42883 to
HTTP 404, which is why it looked like a missing endpoint.

**Why it shipped silently.** PL/pgSQL resolves callee signatures at *first execution*, not
at `CREATE FUNCTION` time. The Phase 4 migration applied cleanly and every structural
guard (function exists, SECURITY DEFINER, anon revoked) passed. Nothing executed the
pricing chain, so the till went to production unable to quote a basket.

**Fix.** Recreated `pos_resolve_line` with `NULL::uuid, NULL::numeric` and removed the dead
CASE. POS has no tax-override parameter, so "no override" is the correct and only intent —
tax comes from the canonical cascade. No pricing, tax, discount or rounding change.

**Verified.** `resolve_sales_line_tax(business, product, NULL::uuid, CURRENT_DATE,
NULL::uuid, NULL::numeric)` now returns `{rate: 16, source: business_default,
tax_rate_id: 8111037e-…}` for the exact product in the failing cart.

**Note on the fail-closed behaviour.** The terminal blocking payment was *correct* — it
must never take money against locally computed prices. The bug was upstream of that guard,
not in it.

**Guard added.** `supabase/tests/pos_pricing_callee_resolution_test.sql` — *executes* the
pricing chain (existence checks cannot catch this class), and fails any POS routine that
passes an untyped NULL or an all-NULL CASE to `resolve_sales_line_tax`.

**Wave lesson.** Every phase that lands a PL/pgSQL routine must include at least one test
that CALLS it. Catalog-shape assertions prove deployment, not executability.

## Phase 9 — offline / retry behaviour ✅ (closed)

**DB seam (verified by independent re-check, all four claims TRUE):**
- `pos_register_open_payment_sessions` — exists, SECURITY DEFINER, anon/PUBLIC EXECUTE revoked.
- `pos_till_close_blockers` — exists, SECURITY DEFINER, anon/PUBLIC revoked.
- `trg_pos_till_close_payment_guard` — attached to `public.pos_shifts`.
- `pos_payment_session_commit` — the `shift_closed` guard sits *after* the apply-log
  replay branch (apply-log at char 305, `shift_closed` at 2696), so an offline retry of
  an already-committed sale still returns its cached envelope rather than being rejected.
- Naming note: the DDL event trigger `_reject_country_named_function` rejects any routine
  name containing `shif` (SHIF statutory token) → hence the `*_till_*` naming.

**Client work landed this pass:**
1. `src/components/pos/CloseShiftDialog.tsx` now gates on `pos_till_close_blockers`
   (was `can_close_pos_shift`), so the cashier sees the `open_payment_sessions` blocker —
   count and amount tendered — before submit instead of meeting the DB trigger error.
2. `src/services/offline/TransactionQueue.ts`
   - `RETRY_DELAY_MS` is now the base of an exponential backoff with ±20% jitter
     (`backoffDelayMs`, capped at `MAX_RETRY_DELAY_MS` = 5 min); the schedule is persisted
     per row as `nextAttemptAt` and `syncAll` drains via `getDueTransactions()`.
   - `isPermanentError` classifies rejections the server will repeat identically
     (`shift_closed`, check/FK/not-null violations, `invalid input syntax`,
     permission denied / 42501, `total mismatch`, `session_not_open`) → the row goes
     `failed` immediately instead of burning all 5 attempts. Everything else (transport,
     timeout, 5xx, unknown) is transient — safe because replay is idempotent: the queued
     id is the key and the session apply-log collapses duplicate commits.
   - `getPendingTransactions()` no longer returns `failed` rows: a permanent rejection is
     terminal until an operator calls `retryTransaction` (which clears `nextAttemptAt`).
3. `src/components/pos/PaymentResumeBanner.tsx` (new, mounted in
   `src/apps/pos/terminal/sale/SaleWorkspace.tsx`) reads
   `pos_register_open_payment_sessions` through `listOpenSessions` in
   `src/lib/pos/paymentSessionClient.ts` and offers resume or discard via the existing
   `pos_payment_session_cancel`, which already refuses to discard captured non-cash money.
4. Guards: `src/test/architecture/pos-offline-retry-and-resume.test.ts` (8 tests, green)
   and `supabase/tests/pos_till_close_guard_test.sql`.

**Stale guard corrected:** `src/test/architecture/pos-offline-replay-uses-rpc.test.ts` was
still asserting a bare `process_pos_transaction` + `p_idempotency_key` call in
`SQLiteSyncManager`. The desktop replay path was migrated to the payment-session saga in
Wave 3 · Phase 1, so the test was failing on obsolete expectations, not a regression. It
now asserts the saga (`openPaymentSession → recordPaymentTender → commitPaymentSession`),
deterministic keys derived from the local `tx.id`, and the unchanged no-direct-insert
rules. Green.

**Residual (not blocking Phase 9):** `getPendingCount()` in the queue now excludes
`failed` rows; surfacing a separate operator-facing "needs attention" count belongs with
the Phase 10 exception surface.

## Next steps

Start **Phase 10 — returns / void / reversal** (carry the pre-existing
`pos-card-fsm.test.ts` failure into that phase).


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

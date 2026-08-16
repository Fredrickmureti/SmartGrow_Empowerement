# POS Wave — Transaction Engine & Canonical Domain Consumer Audit

Authoritative engineering record. Future agents: read the phase table, continue
at the first phase that is not ✅. Do not repeat completed investigation.
Verdicts below are re-verified against the live database and codebase
(not inherited from earlier claims).

## Phase status

| # | Phase | Verdict | State |
|---|---|---|---|
| 0 | POS topology & critical path | ✅ | complete (map below) |
| 1 | Product consumption / read seam | ✅ | verified: RPC-only read, guard test present |
| 2 | UoM & packaging contract | ✅ | verified: packaging/display UoM on the line, server converts |
| 3 | Inventory availability | ✅ | verified: `pos_register_stock_scope` + branch-grained `stock_quants` sync |
| 4 | Pricing / tax authority | ✅ | `pos_resolve_line` + `pos_quote_cart`; tender fails closed without a server quote |
| 4a | POS RPC exposure | ✅ | **fixed this pass** — anon/PUBLIC EXECUTE revoked wave-wide |
| 4b | Commit idempotency race | ✅ | **fixed this pass** — duplicate submit collapses to replay |
| 5 | Transaction state machine | ✅ | **fixed this pass** — table orders now server-priced |
| 6 | Server-side money authority | ✅ | retail + restaurant both quote server-side |
| 7 | Payment integrity | ✅ | **fixed this pass** — server re-derives the payable total at commit; tender hygiene; safe abandon |
| 8 | Concurrency & idempotency (multi-terminal) | ⚠ | **active — next to implement** (held / split / merge / transfer, see F6) |
| 9 | Offline / retry | — | not started |
| 10 | Returns / void / reversal | — | not started |
| 11 | Receipt / printing boundary | — | not started |
| 12 | Event architecture | — | not started |
| 13 | Finance boundary | — | not started (collect dependencies only) |
| 14 | Audit trail | — | not started |
| 15 | Reporting boundary | — | not started |

## Phase 0 — topology (complete)

- Shell/routes: `src/apps/pos/*`; terminal surfaces `src/apps/pos/terminal/{sale,return,held,history,receipt}`.
- Product read (grid/search): `usePOSProducts` → RPC `list_products_with_branch_stock` (single 5-arg overload).
- Product read (scan): `useResolveBarcode` → `pos_resolve_scan` → canonical `resolve_product_identity`.
- Cart (retail): `usePOSCart`; lines carry `packaging_id / display_uom_id / base_uom_id / packaging_label`.
- Cart (restaurant): `useTableOrder` — DB-backed draft `pos_transactions` + `pos_transaction_items`.
- Pricing/tax: `pos_resolve_line` → `resolve_line_unit_price` + `resolve_sales_line_tax`; cart totals `pos_quote_cart`.
- Commit (retail/offline): payment-session saga `openSession → recordTender → commitSession` → `process_pos_transaction`, deterministic key from `useCommitKey(register, shift)`.
- Commit (restaurant): single 4-arg `finalize_table_order` (ADR 0009).
- Receipts: `pos_receipt_snapshots` + `generate-document` (ADR 0086); hardware via main-process orchestrator (ADR 0014).

## Closed findings

### F1 — POS product read seam ✅ (Phase 1)
Duplicate `list_products_with_branch_stock` overload dropped; `usePOSProducts`
reads rows from the RPC only. Guard test forbids `from("products")` in POS code.
Re-verified live: exactly one 5-arg overload in `pg_proc`.

### F3 — POS RPCs were callable by `anon` ❌→✅ (Phase 4a, fixed this pass)
- Evidence: every `pos_*` / `process_pos_transaction` / `finalize_table_order`
  routine is `SECURITY DEFINER` (RLS-bypassing) and still carried the default
  `PUBLIC` EXECUTE grant. An unauthenticated caller could quote carts, read
  register scope and attempt commits. The earlier claim that this was fixed was
  false — verified against `aclexplode(proacl)`.
- Fix: wave-wide revoke from `PUBLIC` + `anon`, grant to `authenticated` and
  `service_role`, with an in-migration post-condition that raises if any leak
  remains. Verified after apply: 0 leaks.
- Regression guard: `supabase/tests/pos_rpc_lockdown_test.sql`.

### F4 — duplicate submit surfaced a raw 23505 ❌→✅ (Phase 4b, fixed this pass)
- Evidence: `process_pos_transaction` pre-checked the idempotency cache, but two
  concurrent submissions of the same key both passed the check; the loser hit
  `pos_transactions_idempotency_key_uidx` and raised `unique_violation` to the
  cashier — for a sale that **did** commit. That is the exact "unknown state"
  this wave forbids (cashier re-charges the customer).
- Fix: body wrapped in a subtransaction with
  `EXCEPTION WHEN unique_violation` that returns the authoritative replay
  envelope (cached response, else the committed row), re-raising only if
  neither exists. Applied by guarded surgery on the live definition so the
  ~20k-char body stays single-sourced.

### F5 — restaurant table orders priced in the browser ❌→✅ (Phase 5, fixed this pass)
- Evidence: `useTableOrder` inserted/updated `pos_transaction_items`
  (`unit_price`, `tax_rate`, `tax_amount`, `line_total`) and
  `pos_transactions` (`subtotal`, `tax_amount`, `total`) directly from JS,
  with its own `calculateItemTotals`. Retail already went through
  `pos_quote_cart`. Two pricing engines, one of them client-side.
- Fix: new RPC `pos_sync_table_order(transaction, lines, expected_version,
  cart_discount_type, cart_discount_value, contact, notes)`:
  - client sends **intent only** (product, quantity, packaging, approved discount, description);
  - server prices via `pos_quote_cart` and writes every money column;
  - refuses non-editable statuses (only draft/open/held/pending);
  - optimistic concurrency on `pos_transactions.version` → returns
    `{ success:false, conflict:true }` instead of last-write-wins;
  - **diffs** lines (update / insert / delete-removed) so `pos_kitchen_orders.transaction_item_id`
    (no FK) keeps pointing at live lines — a wipe-and-reinsert orphaned fired tickets.
  - modifier surcharges ride as non-catalog lines (`product_id NULL`, typed price),
    because `pos_resolve_line` ignores a requested price for catalog products —
    folding the surcharge into `unit_price` would have silently lost that revenue.
- `useTableOrder` totals are now read back from the server-written row.
- Regression guard: `src/test/architecture/pos-table-order-money-authority.test.ts` (6 assertions).

## Open findings

### F6 — held / split / merge / transfer table paths unaudited ⚠ (Phase 8)
`pos_held_transactions`, table merge/split/transfer still need the same
treatment as F5: confirm no client-side money math and that each mutation is
version-guarded. Start here after Phase 7.

## Phase 7 — Payment integrity ✅ (closed this pass)

### F7 — the payable total was never re-derived at the commit boundary ❌→✅
- Evidence: `pos_payment_session_open(p_grand_total …)` took the total straight
  from the terminal (`grandTotal: data.cart.total`), and
  `pos_payment_session_commit` passed `p_total := v_session.grand_total` into
  `process_pos_transaction`, which does **not** call `pos_quote_cart`. The
  Phase 4/6 server quote was therefore advisory: a tampered or stale client
  could commit a basket for any amount it declared.
- Fix (`pos_payment_session_commit`):
  - retail — re-quotes `envelope.items` through `pos_quote_cart` (same resolver
    stack the terminal quotes with) and compares against `session.grand_total`;
    mismatch > 0.01 raises `check_violation` **before** any money moves;
  - the server quote (not the envelope) now supplies `p_subtotal`,
    `p_tax_amount`, `p_discount_amount`, `p_total`;
  - restaurant — compares `session.grand_total` against the server-priced draft
    `pos_transactions.total` written by `pos_sync_table_order`;
  - the committed event carries `server_total` for audit.
- Client: the cart-level discount is now part of the commit intent
  (`cart_discount_type` / `cart_discount_value`) — without it a legitimately
  discounted sale would be re-priced higher and fail closed.
  `CompleteTransactionData.cart_discount` → envelope → `pos_quote_cart`.

### F8 — change/tender hygiene was unconstrained ⚠→✅
- `change_given` could be attached to a card/wallet tender, and a non-cash
  tender could claim `tendered_amount <> amount` (a phantom drawer delta).
- Fix: `pos_payment_session_tenders_change_cash_only` and
  `pos_payment_session_tenders_noncash_exact` CHECK constraints. Verified 0
  pre-existing violating rows.

### F9 — abandoning a funded session silently discarded captured money ❌→✅
- `pos_payment_session_cancel` blanket-reversed every tender, and the 30-minute
  sweeper called it on any `open` session — so a captured card/M-Pesa amount on
  a session the cashier walked away from was marked `reversed` in our books
  while the processor still held the funds.
- Fix: cancel now refuses (`check_violation`, with a HINT) while any non-cash
  tender is un-reversed — it must go through
  `pos_payment_session_reverse_tender` so the reversal is auditable and reaches
  the driver. Cash is still reversed inline (the drawer is still open).
  The sweeper only closes sessions with `pos_payment_session_allocated(...) = 0`,
  and is `service_role`-only.

### Guard precision fixes (not weakenings)
- `pos-payment-session-lifecycle.test.ts` matched any *occurrence* of a session
  RPC name; `useOverridePolicy` legitimately uses
  `pos_payment_session_reverse_tender` as a `pos_override_matrix.action` **code**,
  not a call. The guard now matches `.rpc("…")` invocations only.
- `pos-payment-session-commit-contract.test.ts` scanned whole migration files,
  so cancel's own `status = 'cancelled'` UPDATE was attributed to the sweeper.
  It now extracts the named function body, and additionally asserts the
  sweeper's `allocated = 0` filter.

Regression guards: `supabase/tests/pos_rpc_lockdown_test.sql` (Phase 7 block),
`src/test/architecture/pos-payment-integrity.test.ts` (5 assertions).
Suite status this pass: 35/35 green across the five payment-session suites.

Still open under Phase 7 (carried, not blocking):
- Card terminal path — `useOverridePolicy` maps card actions; the
  `src/test/architecture/pos-card-fsm.test.ts` failure is pre-existing and
  belongs to the card-driver seam (Phase 10 reversal work).
- Timeout/abort UX: the server is now safe (session stays resumable, funded
  sessions are never swept), but the terminal has no "resume this payment"
  affordance. Fold into Phase 9 (offline/retry).

## Phase 8 — Concurrency & idempotency, multi-terminal (next)
Do these in order:
1. `pos_held_transactions` — hold/recall must be version-guarded and must not
   recompute money client-side (same treatment as F5).
2. Table split / merge / transfer (`useBillSplitting`, `useTableTransfer`) —
   confirm every mutation goes through a server RPC that re-prices via
   `pos_quote_cart` and takes an `expected_version`.
3. Two terminals on the same table: prove the loser gets `conflict: true`
   rather than last-write-wins.
4. Drawer/shift boundaries: a shift close concurrent with an in-flight commit.

## Working rules for this wave
- One phase at a time: implement → verify against the DB/live path → record verdict here → next phase.
- No POS-local Product model, UoM converter, inventory calculator or barcode logic.
- Browser is never authoritative for identity, quantity conversion, price, tax, totals or stock.
- Every SECURITY DEFINER routine added in this wave must be revoked from `PUBLIC`/`anon` in the same migration.
- Finance stays out of scope; POS → Finance dependencies collect under Phase 13.

## Instructions for the next agent
1. **Verify before you build.** Re-check Phase 7 against the live DB, not this
   document: `pos_payment_session_commit` must contain both `pos_quote_cart`
   and the `total mismatch` raise; both tender CHECK constraints must exist;
   `pos_payment_session_sweep_abandoned` must filter on `allocated = 0` and be
   `service_role`-only; `SELECT` for anon/PUBLIC EXECUTE leaks on `pos_*` must
   return 0. Run `src/test/architecture/pos-payment-*.test.ts` and
   `src/lib/pos/__tests__/paymentSessionClient.test.ts`.
2. Then start **Phase 8** at step 1 of the list above. Do not jump to Phases
   9-15 while Phase 8 items remain open.
3. Record the verdict for each item in the phase table before moving on.

## Known unrelated failures (do not chase)
Repo-wide `vitest src/test` currently has ~206 pre-existing failures across 123
files (hardware transport mocks, card FSM, etc.). None are in the table-order,
product-read or commit paths touched by this pass.

## F7 — POS grid showed an empty catalogue (operator report, this pass)

Server side is clean: business `bf392ca6…` has 4 active, non-variant-parent
products; the single branch belongs to that business; `stock_quants` are
positive; `list_products_with_branch_stock(uuid,uuid,uuid,boolean,uuid)` is a
single overload with EXECUTE for `authenticated` + `service_role` only
(anon correctly denied, verified by REST probe returning 42501).

Root-cause class: the read seam **swallowed failures**. `usePOSProducts`
threw the RPC error into react-query and the grid rendered the generic
"No products found" empty state — an access/branch-scope error and an empty
catalogue were indistinguishable to the operator, and nothing was logged.

Fix (implemented):
- `usePOSProducts` now logs the RPC error, retries once **unscoped** when the
  seam raises `22023` (stale/foreign branch id from `BranchContext`
  localStorage), sets `retry: false`, and returns `error` / `errorMessage`.
- `POSTerminal → SaleWorkspace → ProductDiscoveryPanel` plumb
  `productsErrorMessage`; a failed read now renders a distinct destructive
  state instead of "No products found".
- Guard test `pos-product-read-seam.test.ts` still passes (RPC-only read).

Next agent: if the grid is still empty for a signed-in operator, the terminal
now displays the exact RPC error — capture it before further investigation.
Then resume Phase 8 (multi-terminal concurrency: held / split / merge /
transfer, see F6).

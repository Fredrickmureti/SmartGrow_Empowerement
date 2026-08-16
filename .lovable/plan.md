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
| 7 | Payment integrity | — | **active — next to implement** |
| 8 | Concurrency & idempotency (multi-terminal) | ⚠ | commit path done; held/split/merge paths unaudited |
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

## Phase 7 — Payment integrity (next)
Verify against the live DB and code:
1. `pos_payment_sessions` / `pos_payment_session_tenders` FSM: can a session
   commit twice, or commit with `sum(tenders) <> total`? Is the total re-derived
   server-side at commit, or trusted from the client?
2. Cash overtender/change invariants (ADR 0009) enforced in SQL, not only in the dialog.
3. Card terminal path: `useOverridePolicy.ts` calls `pos_card_*` RPCs directly and
   breaks `src/test/architecture/pos-card-fsm.test.ts` (pre-existing failure, unrelated
   to this pass) — route it through `CardTerminal` or widen the guard deliberately.
4. Timeout/abort: an in-flight tender that never returns must leave the session
   resumable, never the cart.

## Working rules for this wave
- One phase at a time: implement → verify against the DB/live path → record verdict here → next phase.
- No POS-local Product model, UoM converter, inventory calculator or barcode logic.
- Browser is never authoritative for identity, quantity conversion, price, tax, totals or stock.
- Every SECURITY DEFINER routine added in this wave must be revoked from `PUBLIC`/`anon` in the same migration.
- Finance stays out of scope; POS → Finance dependencies collect under Phase 13.

## Known unrelated failures (do not chase)
Repo-wide `vitest src/test` currently has ~206 pre-existing failures across 123
files (hardware transport mocks, card FSM, etc.). None are in the table-order,
product-read or commit paths touched by this pass.

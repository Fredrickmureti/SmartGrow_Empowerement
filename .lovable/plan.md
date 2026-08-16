# POS Wave — Transaction Engine & Canonical Domain Consumer Audit

Authoritative engineering record. Future agents: read the phase table, continue
at the first phase that is not ✅. Do not repeat completed investigation.

## Phase status

| # | Phase | Verdict | State |
|---|---|---|---|
| 0 | POS topology & critical path | ✅ | complete (map below) |
| 1 | Product consumption / read seam | ❌ | **REOPENED — catalogue RPC broken in production (F10)** |
| 2 | UoM & packaging contract | ✅ | packaging/display UoM on the line, server converts |
| 3 | Inventory availability | ✅ | `pos_register_stock_scope` + branch-grained `stock_quants` |
| 4 | Pricing / tax authority | ✅ | `pos_resolve_line` + `pos_quote_cart` |
| 4a | POS RPC exposure | ✅ | anon/PUBLIC EXECUTE revoked wave-wide |
| 4b | Commit idempotency race | ✅ | duplicate submit collapses to replay |
| 5 | Transaction state machine | ✅ | table orders server-priced |
| 6 | Server-side money authority | ✅ | retail + restaurant quote server-side |
| 7 | Payment integrity | ✅ | server re-derives payable total at commit |
| 8 | Concurrency & idempotency (multi-terminal) | ⚠ | held / split / merge / transfer (F6) — next after Phase 1 closes |
| 9-15 | Offline, returns, printing, events, finance, audit, reporting | — | not started |

## Phase 0 — topology (complete)

- Shell/routes: `src/apps/pos/*`; terminal `src/apps/pos/terminal/{sale,return,held,history,receipt}`.
- Product read (grid/search): `usePOSProducts` → RPC `list_products_with_branch_stock` (single 5-arg overload).
- Product read (scan): `useResolveBarcode` → `pos_resolve_scan` → canonical `resolve_product_identity`.
- Cart (retail): `usePOSCart`; lines carry `packaging_id / display_uom_id / base_uom_id / packaging_label`.
- Cart (restaurant): `useTableOrder` → `pos_sync_table_order` (server-priced draft).
- Pricing/tax: `pos_resolve_line` → `resolve_line_unit_price` + `resolve_sales_line_tax`; totals `pos_quote_cart`.
- Commit: payment-session saga → `process_pos_transaction` (retail) / `finalize_table_order` (restaurant).
- Receipts: `pos_receipt_snapshots` + `generate-document`.

## ACTIVE — F10: catalogue RPC return-type mismatch (Phase 1, reopened)

Operator symptom: POS terminal shows "Product catalogue could not be loaded —
structure of query does not match function result type".

Root cause (confirmed against the live database, not inferred):
`public.list_products_with_branch_stock` declares
`RETURNS TABLE(… etims_tax_code text …)` but the final `RETURN QUERY` selects
`tr.etims_tax_code`, and `public.tax_rates.etims_tax_code` is
`character varying`. plpgsql requires the returned row type to match the
declared row type exactly, so **every** call fails at execution time,
regardless of tenant, branch or data. This is a hard regression introduced when
the eTIMS tax columns were added to the seam — no product row can ever be
returned. All other declared columns type-match (verified column-by-column via
`information_schema.columns`).

Note: the previous pass's "F7 — grid showed an empty catalogue" diagnosis
(stale branch id / swallowed error) was wrong as a root cause. Its error-surfacing
work was still valuable — it is what made this real fault visible — but the
`22023` unscoped-retry fallback must stay a fallback, not a workaround.

### Fix (Phase 1 closure)

1. **Migration** — `CREATE OR REPLACE` the function with the identical body plus
   an explicit `tr.etims_tax_code::text` cast (declared signature unchanged, so
   no drop/recreate and no overload risk). Re-assert grants: `authenticated` +
   `service_role` only, revoke `PUBLIC`/`anon`.
2. **Sweep the same class of defect** across every RPC POS reads from —
   `pos_resolve_scan`, `pos_resolve_line`, `pos_quote_cart`,
   `resolve_stock_availability_batch`, `get_available_pos_stock_for_register[_batch]`,
   `resolve_product_identity` — by comparing each declared `RETURNS TABLE`
   column type against the source column type. Fix any other varchar/text or
   enum/text drift in the same migration. A silent-at-deploy, fatal-at-call
   mismatch must not be able to recur unnoticed.
3. **Regression guard** — `supabase/tests/pos_product_read_seam_test.sql`:
   executes the catalogue RPC and asserts it returns without raising, and
   asserts the declared return type of the eTIMS/UoM/category columns.
4. **Verify live** — call the seam for the test tenant and confirm rows come
   back with populated `packaging`, `base_uom_code`, `available`, and category
   name; then confirm the terminal grid renders products.

Do not add a POS-local product query, a client-side fallback catalogue, or
loosen the read seam to `from("products")` to make the screen work.

## Verification of the previous engineer's claims (this pass)

- Phase 1 "verified: RPC-only read" — **false in effect**: the seam is RPC-only
  in code, but the RPC itself cannot execute (F10). Verdict reset to ❌ above.
- Single 5-arg overload of `list_products_with_branch_stock` — **confirmed**
  (one row in `pg_proc`).
- Remaining Phase 4a/4b/5/7 claims are re-verified opportunistically as their
  surfaces are touched; they are not re-audited wholesale here because F10 is
  a live production outage and takes precedence.

## Open findings

### F6 — held / split / merge / transfer table paths unaudited ⚠ (Phase 8)
`pos_held_transactions`, table merge/split/transfer still need the F5 treatment:
no client-side money math, every mutation version-guarded through a server RPC
that re-prices via `pos_quote_cart`. Order of work:
1. hold/recall; 2. split/merge/transfer; 3. prove the losing terminal gets
`conflict: true`; 4. shift close concurrent with an in-flight commit.

### Carried from Phase 7 (non-blocking)
- Card terminal path: `pos-card-fsm.test.ts` failure is pre-existing, belongs to
  the card-driver seam (fold into Phase 10 reversal work).
- No "resume this payment" affordance in the terminal after a timeout — Phase 9.

## Working rules for this wave
- One phase at a time: implement → verify against the live DB → record verdict → next.
- No POS-local Product model, UoM converter, inventory calculator or barcode logic.
- Browser is never authoritative for identity, quantity conversion, price, tax, totals or stock.
- Every SECURITY DEFINER routine added must be revoked from `PUBLIC`/`anon` in the same migration.
- Finance stays out of scope; POS → Finance dependencies collect under Phase 13.

## Known unrelated failures (do not chase)
Repo-wide `vitest src/test` has ~206 pre-existing failures across 123 files
(hardware transport mocks, card FSM, etc.), none in the product-read, table-order
or commit paths.

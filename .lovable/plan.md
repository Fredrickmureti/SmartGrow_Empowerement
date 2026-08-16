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
| 8 | Concurrency & idempotency (multi-terminal) | ⚠ | **active — next** (F6: held / split / merge / transfer) |
| 9-15 | Offline, returns, printing, events, finance, audit, reporting | — | not started |

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

### F6 — held / split / merge / transfer table paths unaudited ⚠ (Phase 8, next)
`pos_held_transactions`, table merge/split/transfer still need the F5 treatment:
no client-side money math, every mutation version-guarded through a server RPC
that re-prices via `pos_quote_cart`. Order of work:
1. hold/recall; 2. split/merge/transfer; 3. prove the losing terminal gets
`conflict: true`; 4. shift close concurrent with an in-flight commit.

### Carried from Phase 7 (non-blocking)
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

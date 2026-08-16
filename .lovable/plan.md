# Supplier Conditions (ex "Vendor Price Lists") — implementation status

Authoritative status for the procurement supplier-conditions wave.
Source audit + phase definitions: `.lovable/plan/supplier-purchasing-conditions-audit-findings-and-reconstruc-2026-08-16.md`.
Decisions: ADR 0141, ADR 0142. Memory: `mem://features/supplier-purchasing-terms`.

## Currently active phase

None — Phases 1-8 are implemented. The wave is at a coherent, production-ready
state. The next agent starts with verification (below), not new construction.

## Fully implemented and verified

| Phase | Outcome | Verified by |
|---|---|---|
| 1 — Price-complete resolver | `resolve_supplier_purchasing_terms(business, product, supplier, on_date, quantity, branch)` selects the highest `price_break_tiers` row at or below the ordered quantity and returns `price_source` | `supabase/tests/supplier_purchasing_conditions_test.sql` |
| 2 — One purchase price authority | `resolve_purchase_line_price` — precedence contract line → supplier tier → supplier flat → product default → manual, resolved server-side only | SQL guard + architecture test |
| 3 — Branch scope & validity | Overlap guard keys `branch_id` (branch row coexists with company-wide NULL); `public.effective_status(supplier_item_terms)` is a server-computed status (`active / expiring_soon / expired / scheduled / inactive / draft / pending_approval / rejected`), `authenticated`-only, `anon` revoked; `lead_time_days` column comment records the calendar-day definition | SQL guard #6, #7 |
| 4 — Governance, audit, events | `upsert_supplier_item_terms` routes `supplier_terms.amend` through `approval_route`, writes `audit_logs`, emits `procurement.supplier_terms.*` to `business_event_outbox` in the same transaction | SQL guard |
| 5 — PO line provenance | `purchase_order_items.supplier_terms_id` + `price_source`, stamped by `_po_item_stamp_price_provenance` from the Phase 2 authority | SQL guard #5 |
| 6 — Purchases consumption | `purchaseLineTerms.ts` (single adapter) returns the resolved price, unit and provenance; PO create/edit and requisition create default from it and refuse MOQ/increment violations server-side | architecture test |
| 7 — Workspace UI | Renamed to **Supplier Conditions** (page + nav + exports); server `effective_status` drives badges, filters and stats; new "Pending approval" summary; form has canonical currency select (business-enabled currencies), purchase-unit select (compatible UoMs), order increment, price-break tier editor, and ranked sourcing (`preferred_rank`, 1 = primary) replacing the boolean | typecheck + architecture tests |
| 8 — Ratchets | `src/test/architecture/purchasing-terms-single-owner.test.ts` (8 tests, passing): single RPC seam, no browser precedence, no browser MOQ/tier arithmetic, no browser validity-window arithmetic, adapter-only reads. `supabase/tests/supplier_purchasing_conditions_test.sql` (7 checks) | `bunx vitest run src/test/architecture/purchasing-terms-single-owner.test.ts` |

## Pending / deliberately out of scope

- **Operator price override policy.** PO lines still accept a manual price above
  the resolved one (recorded as `price_source = 'manual'`). Whether a manual
  override must be approved is a governance decision, not a defect.
- **Context carry-in preselects** (open a condition pre-filled from a product,
  supplier or requisition) — nice-to-have from Phase 7, not wired.
- **Route slug** is still `/purchases/price-lists`; only the label changed. A
  slug change needs a legacy redirect entry.
- **`notes`** stays free text with no lifecycle, by design. No engine reads it.

## Instructions for the next agent

1. **Verify before building.** Run, in order:
   - `bunx vitest run src/test/architecture/purchasing-terms-single-owner.test.ts`
   - `supabase/tests/supplier_purchasing_conditions_test.sql` and
     `supabase/tests/supplier_purchasing_terms_test.sql` against the database
   - `bunx tsgo --noEmit -p tsconfig.app.json`
   Then open `/purchases/price-lists` signed in and confirm: statuses come from
   `effective_status` (never `new Date()`), the tier editor round-trips, and a
   condition edit produces an `audit_logs` row plus a
   `procurement.supplier_terms.amended` outbox row.
2. **Do not re-open a closed phase** unless a guard fails. If one fails, fix the
   engine, not the guard.
3. **Next logical milestone** (in order, only after verification passes):
   a. Purchase-price *ceiling* policy — decide and enforce whether a manual
      override above the resolved price requires approval, reusing
      `approval_route`; stamp the override reason on the line.
   b. Context carry-in preselects for the conditions workspace.
   c. Supplier coverage view — products with no active approved condition —
      built on the existing resolver, no new engine.
4. **Boundaries that must hold:** one price authority
   (`resolve_purchase_line_price`), one client seam
   (`src/features/products/purchasing/supplierPurchasingTerms.ts`) reached from
   Purchases only via `purchaseLineTerms.ts`, no browser arithmetic on price,
   quantity or validity, conditions create no accounting.

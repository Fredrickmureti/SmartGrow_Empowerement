# Landed Cost Domain — Verification Result & Completion Plan

**Authoritative status file.** Update after every implementation step.

## Domain definition (settled, unchanged)

A **Landed Cost Voucher** accumulates acquisition charges (freight, insurance, duty,
clearing, handling, demurrage) and capitalises them onto stock received on one or more
Goods Receipts. It is a value-only event: quantities never change.

Lifecycle: `draft → (pending_approval) → allocated → posted → reversed | cancelled`.

Posting effect:
```text
Dr Inventory              share still on hand
Dr Cost of Goods Sold     share already sold
Dr <expense account>      non-capitalisable charges
    Cr Landed Cost Clearing   total charge (base currency)
```

---

## Phase 1 — Independent verification of the previous engineer's claims

Checked directly against the database and the working tree.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Phase 1 — inventory revaluation foundation | Present | `inventory_cost_revaluations` table plus `inventory_apply_cost_revaluation` / `inventory_reverse_cost_revaluation` functions exist |
| Phase 2 — domain model | Present | `landed_cost_vouchers`, `landed_cost_components`, `landed_cost_component_types`, `landed_cost_allocations` exist; legacy `landed_cost_bills` gone |
| Phase 3 — allocation engine | Present | `landed_cost_allocate_voucher`, `landed_cost_voucher_receipts`, numbering helpers exist |
| Phase 4 — posting & reversal | Present | `landed_cost_post_voucher`, `landed_cost_reverse_voucher`, `match_bill_with_landed_cost` exist; 6 seeded component types |
| Phases 1–4 behaviourally verified | **Not verified** | Zero rows in vouchers, components, allocations, revaluations — **and `goods_receipts` is entirely empty**, so no engine has ever executed |
| Phase 5 three files landed | Present | `landedCostRpcs.ts`, `useLandedCosts.ts`, `landedCostView.tsx` exist under `src/features/purchases/landed-costs/` |
| "New files not type-checked" | Confirmed, and worse | `tsconfig.app.json` **excludes `src/features` entirely** — a typecheck cannot catch these files at all. The known break is real: `landedCostView.tsx` sets `kind: "landed_cost_voucher"`, which is not a member of `DocumentKind` |
| Phase 5 remaining surfaces | Missing | No list/record/peek/create page; `/purchases/landed-costs` still routes to the interim read-only `src/pages/purchases/LandedCosts.tsx` |

Additional findings not in the previous plan:

- The two data hooks read business context from `@/contexts/BusinessContext`, while the
  live page uses `@/hooks/useBusinesses`. One of the two is the canonical accessor and
  the feature must use it consistently.
- Structural existence of the RPCs is not evidence of correctness. Because no goods
  receipt has ever existed in this database, the allocation, revaluation, posting and
  reversal paths are **entirely unexercised**. Verification must therefore come from a
  seeded end-to-end run, not from reading SQL.

Conclusion: the last genuinely completed milestone is **Phase 4 (deployed, unverified)**.
Phase 5 is roughly one third landed and does not compile against the design system.

---

## Phase 5A — Prove the engines before building UI on them

Do this first; building a workspace on unverified engines is how defects get hidden.

1. Seed a scratch scenario in a test business: supplier, PO, posted goods receipt with
   two stock-tracked products and one non-stock line, cost layers created.
2. Create a voucher with two charges (one capitalisable, one expensed), scope it to that
   receipt, run `landed_cost_allocate_voucher`. Assert: allocations sum exactly to the
   charge total; the non-stock line is skipped with a reason; re-running is idempotent.
3. Run `landed_cost_post_voucher`. Assert: journal balances and hits Inventory / COGS /
   Landed Cost Clearing; `cost_layers.unit_cost` rose only on remaining quantity; one
   `inventory_cost_revaluations` row per layer.
4. Run `landed_cost_reverse_voucher`. Assert: unit costs and ledger return to prior
   state; `reversed_at` set; mirror JE posted.
5. Negative cases: posting into a locked fiscal period is refused; posting with
   `landed_cost_clearing` unmapped is refused with a clear error, not a silent fallback.
6. Capture these as repeatable pgTAP tests under `supabase/tests/` so they stay true.

Any failure here becomes a Phase 4 fix and is done before Phase 5B.

---

## Phase 5B — Workspace UI (finish the partial work)

1. Register `landed_cost_voucher` in `DocumentKind` and add its status overrides in
   `src/design-system/records/documentStatus.tsx` (draft / pending approval / allocated /
   posted / reversed / cancelled with correct tones). Without this the existing view file
   does not compile.
2. Normalise the business-context import in `useLandedCosts.ts` to the canonical hook.
3. `LandedCostRecordPage.tsx` — `RecordScaffold` over `useLandedCostView`, status-gated
   action bar (Allocate / Post / Reverse), reversal-reason dialog, errors surfaced from
   the RPC result rather than a generic toast.
4. `LandedCostPeekSheet.tsx` — `PeekScaffold` over the same descriptor.
5. `LandedCostListPage.tsx` — status lenses and a KPI ribbon whose every number is a real
   aggregate over `landed_cost_vouchers` (drafts, awaiting allocation, allocated not
   posted, posted this period, reversed). No decorative metrics.
6. `LandedCostCreatePage.tsx` — voucher header (date, currency + canonical FX rate,
   default basis, shipment reference), charge lines drawn from the component-type
   catalog, and receipt scope picked from real completed goods receipts.
7. Replace `src/pages/purchases/LandedCosts.tsx` with a re-export of the list page; add
   `landed-costs/new` and `landed-costs/:id` routes in `src/apps/purchases/routes.tsx`.
8. Extend the typecheck to cover `src/features` (or add a feature-scoped tsconfig) so
   this class of break cannot land silently again.

---

## Phase 5C — Catalog & registries

- Component-type settings screen (catalog CRUD, capitalisable flag, expense account
  binding — no hardcoded accounts, no country assumptions).
- Register `landed_cost_voucher` in the `document_kinds` registry and the governance
  action registry (`landed_cost.post`, `landed_cost.reverse`).

## Phase 6 — Approvals, matching & reporting (unchanged, still pending)

- Wire `approval_requests` for posting (column already exists) and enforce the gate.
- Surface landed-cost uplift inside the 3-way bill match UI.
- Landed cost per receipt / product / supplier reports plus a clearing-account ageing
  integrity check, all reading canonical finance and inventory data.

---

## Open items / known gaps

1. `weight` / `volume` allocation bases are rejected by the engine because
   `products` has no net weight or volume master data. Enabling them is a
   product-master change, not a landed-cost change.
2. Approval gating on posting is modelled but not enforced.
3. All engine behaviour remains unproven until Phase 5A runs.

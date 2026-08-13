# Landed Cost — Verification Verdict & Completion Plan

## Verification of the previous engineer's final claims

Checked directly against the working tree.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| `landed_cost_voucher` registered in the document-kind registry with status tones | Confirmed | Present in `documentStatus.tsx` (kind union + status meta block) |
| `useLandedCostActions` — single action vocabulary, server-RPC driven | Confirmed | Allocate / Post / Reverse (reason required) / Delete-draft, each calling a database RPC; read-only + subscription guards present; no browser status writes |
| `LandedCostRecordPage` (full page) and `LandedCostPeekSheet` (drawer) off one descriptor | Confirmed | Both project the shared `useLandedCostView` through `RecordScaffold` / `PeekScaffold` |
| `LandedCostListPage` — lifecycle buckets, KPIs, search, peek | Confirmed | Aggregates computed from real voucher rows (`landedCostKpis`), no fabricated metrics |
| Create page pending | Confirmed missing | No `LandedCostCreatePage.tsx` |
| Route wiring pending | Confirmed missing | `src/apps/purchases/routes.tsx` still lazy-loads the interim `src/pages/purchases/LandedCosts.tsx`; no `new` / `:id` routes. **The four new pages are therefore unreachable in the running app.** |
| Business-context import inconsistent | Not a defect | `@/hooks/useBusinesses` is a re-export of `@/contexts/BusinessContext`; both resolve to the same hook. Worth normalising for consistency only. |
| `src/features` excluded from typecheck | Confirmed | `tsconfig.app.json` excludes `src/features`, so none of these files are covered by the project typecheck |

Verdict: Phase 5B is genuinely ~80% landed and of good architectural quality. The gap is the create surface, the routing, and the typecheck blind spot.

## Phase 5B — finish (this work)

1. **`LandedCostCreatePage.tsx`** — draft voucher creation using the hooks that already exist (`useLandedCostComponentTypes`, `useCompletedGoodsReceipts`):
   - header: voucher date, currency + canonical FX rate, default allocation basis, shipment reference, supplier/notes;
   - charge lines chosen from the component-type catalog (capitalisable flag and expense account come from the catalog row — never hardcoded);
   - receipt scope picked from real completed goods receipts (searchable);
   - insert header → components → receipt scope; totals are left to the `_landed_cost_voucher_recalc` trigger. On success navigate to the record page. No allocation or posting from the browser.
2. **Route wiring** in `src/apps/purchases/routes.tsx`: `landed-costs` → `LandedCostListPage`, `landed-costs/new` → create page, `landed-costs/:id` → record page. Delete `src/pages/purchases/LandedCosts.tsx` (interim shell, superseded).
3. **Typecheck coverage**: add `src/features/purchases/landed-costs/**` to the typechecked set so this class of break cannot land silently again; run the check and fix whatever it surfaces.
4. Normalise the business-context import in `useLandedCosts.ts` to `@/hooks/useBusinesses` for consistency with the rest of Purchases.

## Phase 5C — catalog & registries

- Component-type settings screen: catalog CRUD with capitalisable flag and expense-account binding (country-agnostic, account resolved through `default_account_settings`).
- Register `landed_cost_voucher` in the `document_kinds` registry and the governance action registry (`landed_cost.post`, `landed_cost.reverse`).

## Phase 6 — approvals, matching, reporting

- Enforce the approval gate on posting via `approval_requests` (the column is modelled but unenforced).
- Surface landed-cost uplift inside the 3-way bill-match UI.
- Landed cost per receipt / product / supplier reports plus a clearing-account ageing integrity check, all reading canonical finance and inventory data.

## Carried-over known gaps

- `weight` / `volume` allocation bases stay rejected until the product master carries net weight/volume — a product-domain change, not a landed-cost one.
- Engine behaviour was proven end-to-end by the `landed_cost_selftest` run (Phase 5A); pgTAP capture of those assertions under `supabase/tests/` is still outstanding and is folded into Phase 6.

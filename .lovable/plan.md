# Landed Cost — Verification Verdict & Remaining Phases

## Phase 1 — Independent verification (done, evidence below)

Checked against the working tree and the live database, not against the previous notes.

| Claim / plan item | Verdict | Evidence |
| --- | --- | --- |
| List / Record / Peek surfaces off one descriptor | Confirmed | `LandedCostListPage`, `LandedCostRecordPage`, `LandedCostPeekSheet`, `landedCostView.tsx` |
| Create page pending | **Now done** | `LandedCostCreatePage.tsx` exists; currency uses the canonical `CurrencyCombobox` over `public.currencies`, rate is read-only via `describe_exchange_rate`, no client base-amount arithmetic |
| Route wiring pending | **Now done** | `src/apps/purchases/routes.tsx` wires `landed-costs`, `/new`, `/:id`; the interim `src/pages/purchases/LandedCosts.tsx` is gone |
| Typecheck blind spot | **Now covered** | `tsconfig.landed-costs.json` + `npm run typecheck:landed-costs` |
| FX made server-authoritative | Confirmed in DB | Trigger `trg_lc_vouchers_fx_stamp` → `_landed_cost_voucher_fx_stamp`; `landed_cost_allocate_voucher` raises when no rate is on file; no `COALESCE(rate, 1)` remains in the allocation/sync path |
| Posting through the canonical engine | Confirmed | `landed_cost_post_voucher` resolves accounts via `resolve_posting_account`, checks `is_period_locked`, revalues via `inventory_apply_cost_revaluation`, posts one balanced entry through `post_journal_entry_atomic`, emits `_emit_landed_cost_outbox` |
| Consumed stock handled | Confirmed | Post splits `capitalized` vs `expensed` from the revaluation result and books the sold portion to COGS |
| Legacy ADR-0077 engine removed | Confirmed | `landed_cost_bills`, `allocate_l_bill`, `post_l_bill`, `reverse_l_bill` no longer exist in the database |

**Genuinely still missing** (verified absent, not assumed):

- No approval gate: `landed_cost_post_voucher` contains no governance call. The canonical engine is `approval_route` / `approval_decide` + a `_mirror_approval_to_*` trigger + a self-approval guard — landed cost has none of the three, and no `landed_cost.post` action is registered.
- No component-type catalog UI. `landed_cost_component_types` holds 6 rows, but nothing in `src/` outside the landed-cost feature reads or maintains it.
- No document kind: `document_kinds` has no landed-cost row, so there is no print/download/email profile and no snapshot builder.
- No pgTAP coverage under `supabase/tests/`; the only proof is the ad-hoc `landed_cost_selftest` function.
- No architecture guard test for this module.
- No landed-cost visibility in Finance or Inventory reporting surfaces.
- `weight` / `volume` bases still raise — product master carries no net weight/volume.

## Phase 2 — Remaining work, dependency-ordered

### 5C.1 Governance gate (server first)
Register `landed_cost.post` (and `landed_cost.reverse`) in the governance action registry. `landed_cost_post_voucher` calls the canonical approval path: when a matching rule exists it routes an approval request via `approval_route` and leaves the voucher `pending_approval` instead of posting; a `_mirror_approval_to_landed_cost` trigger applies the decision and resumes posting. Add the self-approval guard trigger consistent with the other documents. No landed-cost-local approval columns beyond the mirror the other modules already use.

### 5C.2 Component-type catalog screen
A settings surface for `landed_cost_component_types`: name, capitalisable flag, default allocation basis, expense account bound through `default_account_settings` (no country-specific literals, no seeded vocabulary beyond what the tenant configures).

### 5C.3 Document profile
Register a `landed_cost_voucher` document kind with its own snapshot builder and template — landed-cost vocabulary (charges, allocation basis, affected receipts, capitalised vs expensed), never invoice/"Bill To" semantics. Reuse the shared rendering/print/email pipeline.

### 6.1 Reporting integration
Surface landed cost through the canonical paths only: clearing-account balance and capitalised-vs-expensed exposure in Finance; unit-cost uplift per receipt/product in Inventory valuation reporting; landed-cost uplift shown inside the 3-way bill-match view. No landed-cost-specific totals tables.

### 6.2 Test & guard layer
- pgTAP under `supabase/tests/landed_cost_*`: FX stamping and refusal without a rate, deterministic allocation with rounding drift absorbed, capitalised/expensed split when stock is partly sold, balanced journal (debits = credits), period-lock refusal, posted-voucher immutability, reversal symmetry, idempotent re-post.
- `src/test/architecture/landed-cost-domain.test.ts`: no second FX/approval/accounting/valuation implementation inside the module, no client-side authoritative arithmetic, no direct journal or status writes from the browser.
- Retire `landed_cost_selftest` once pgTAP covers its assertions.

### 6.3 Carried-over dependency
`weight` / `volume` allocation stays refused until the product master carries net weight/volume — that is a product-domain change and will be raised there, not solved locally.

## Technical notes

- Canonical engines this work consumes: `approval_route` / `approval_decide` (governance), `resolve_exchange_rate` / `fx_stamp_document` (FX), `inventory_apply_cost_revaluation` (valuation), `post_journal_entry_atomic` (accounting), `resolve_posting_account` + `default_account_settings` (account roles), `business_event_outbox` (events), the shared document/render pipeline, existing RLS + `user_has_business_access` (security).
- All lifecycle transitions stay server-side RPCs; the browser keeps requesting operations only.

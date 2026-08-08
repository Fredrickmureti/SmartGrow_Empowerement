# Estimate / Quotation Lifecycle — Audit Verdict and Convergence Plan

## 1. Executive verdict

**Partially sound foundation, with two production-breaking defects and a missing lifecycle spine.**

The document layer (snapshot builder, PDF/print, branding, UoM provenance) and the RLS/branch scoping on `estimates` are correct and should not be touched. The *commercial lifecycle* is not implemented as a domain: status is a free-form client-side dropdown, and both conversion RPCs reference columns that do not exist in the database, so neither conversion can ever succeed.

Two verified P0s (both would raise a Postgres error on first real use — the estimates table is currently empty, which is why nobody has hit them):

- `convert_estimate_to_invoice_atomic` inserts `source_estimate_id` into `public.invoices`. **That column does not exist.** Estimate → Invoice is dead.
- `convert_estimate_to_so_atomic` reads `v_est.valid_until`. **That column does not exist** on `estimates` (the column is `expiry_date`). Estimate → Sales Order is dead.

## 2. Verified domain model (what exists today)

```text
crm_leads --convert_lead_to_estimate--> estimates ──┬─(broken)─> invoices
                                                    └─(broken)─> sales_orders -> deliveries -> invoices -> AR/GL
proforma_invoices.source_estimate_id  (a third, separate downstream path)
```

- `estimates` (org, business, branch, contact, number, status, issue_date, **expiry_date**, subtotal, tax, discount, total, currency, notes, terms, `converted_invoice_id`, `converted_at`, signature fields, `source_lead_id`, `template_id`).
- `estimate_items` — carries a **price/tax snapshot** plus UoM provenance (`packaging_id`, `display_uom_id`, `display_quantity`, `uom_snapshot`). This is correct: values are frozen at line level, not re-read from products.
- `estimate_additional_costs` — freight/handling style costs, taxable flag.
- Status enum: `draft, sent, viewed, accepted, rejected, expired, converted`.

## 3. Financial boundary (verified — and correct)

| Event | AR | Revenue | Tax | Inventory | GL |
|---|---|---|---|---|---|
| Create / send / view / accept / reject / expire estimate | no | no | no | no | no |
| Convert → sales order | no | no | no | no (no reservation) | no |
| Invoice issue | yes | yes | yes | via delivery | yes |

This matches Odoo/NetSuite/SAP/Dynamics: a quotation is a **commercial offer**, not an accounting event. No GL posting should be added at any estimate stage. **No change required here.**

## 4. Findings

**Critical**
1. `convert_estimate_to_invoice_atomic` writes a non-existent `invoices.source_estimate_id`.
2. `convert_estimate_to_so_atomic` reads a non-existent `estimates.valid_until`.
3. Conversion is **lossy**: `estimate_additional_costs` are never carried to the invoice or sales order, and `packaging_id / display_uom_id / display_quantity / uom_snapshot` are dropped even though both target item tables have those columns. The downstream total can therefore differ from what the customer accepted.
4. No server-side state machine. `handleStatusChange` (src/pages/Estimates.tsx:339) calls `updateEstimate(id,{status})`, so any user can move `converted → draft` or `rejected → accepted` with no guard, no timestamp, no audit event.

**High**
5. Totals math diverges between create and edit: `createEstimate` includes additional costs in `total`; `updateEstimate` recomputes `total = subtotal + tax − discount`, silently dropping them. Editing an estimate changes its price.
6. `updateEstimate` does not persist `additional_costs` at all (stripped as `_ac`).
7. `get_next_so_number(_org_id)` is org-scoped with **no advisory lock and no business/branch scope**, unlike `get_next_estimate_number` / `get_next_invoice_number`. Two numbering philosophies; duplicate SO numbers under concurrency.
8. `get_next_estimate_number` strips *all* digits including the year before `MAX(...)+1`, so the second estimate of a year becomes `EST-2026-20260002`. Not yet observable (zero rows) but wrong by construction.
9. `estimate_items` carries two competing RLS policy families (legacy org-wide `Users can …` + `estimate_items_*_perm`), and `estimate_additional_costs` policies are **org-wide with no business check** — cross-business visibility inside one organization, unlike the parent table.

**Medium**
10. No expiry automation: `expiry_date` is displayed but nothing ever moves an estimate to `expired`.
11. No lifecycle timestamps (`sent_at`, `viewed_at`, `accepted_at`, `rejected_at`) and no `converted_sales_order_id`; `converted_at` is set only on the invoice path, so an SO conversion leaves `status='converted'` with no forward pointer on the estimate.
12. `get_document_lineage` has no direct estimate→invoice edge (it walks invoice → sales_order → estimate), so even a fixed direct conversion is invisible to lineage.
13. Duplicate creation surfaces: an inline create path in `src/pages/Estimates.tsx` alongside `EstimateCreatePage`.

**Correct — do not change**
- Line-level price/tax/UoM snapshot on `estimate_items`.
- `estimates` RLS (business + module permission) and `trg_estimates_branch_business_match`.
- Document snapshot/print pipeline (`services/documents/snapshots/salesEstimate.ts`) and its tests.
- The decision that estimates never post to the GL.
- `convert_lead_to_estimate` and the CRM no-client-conversion guard.

## 5. Convergence plan

**Phase 0 — unbreak conversion (migration)**
- Add `invoices.source_estimate_id uuid REFERENCES estimates(id)` (nullable, indexed).
- Fix `convert_estimate_to_so_atomic` to read `expiry_date`.
- Both RPCs: copy `packaging_id, display_uom_id, display_quantity, uom_snapshot` and materialise `estimate_additional_costs` as extra document lines so totals reconcile exactly; assert the resulting header total equals the estimate total or raise.
- Record the forward pointer for the SO path.

**Phase 1 — lifecycle spine (migration)**
- Add `estimates.sent_at, viewed_at, accepted_at, rejected_at, converted_sales_order_id`.
- New `set_estimate_status_atomic(p_estimate_id, p_status, p_user_id)` owning the only legal transition table: `draft→sent→viewed→accepted|rejected|expired`, `accepted→converted`, terminal states closed. Stamps the matching timestamp and writes an audit row.
- Trigger on `estimates` blocking direct client `status` writes so the RPC is the single writer.
- Extend `get_document_lineage` with the direct estimate→invoice edge.

**Phase 2 — numbering convergence (migration)**
- `get_next_so_number(_org_id, _business_id, _branch_id)` mirroring the estimate/invoice function: config-driven prefix, advisory lock, business+branch scope. Keep the old signature as a thin delegate for compatibility.
- Fix the sequence extraction in `get_next_estimate_number` (and the SO twin) to parse only the trailing counter segment.

**Phase 3 — RLS convergence (migration)**
- Drop the legacy org-wide `estimate_items` policies; keep one business-scoped family aligned with the parent.
- Rewrite `estimate_additional_costs` policies to inherit the parent's business + module-permission check.

**Phase 4 — frontend alignment**
- Route every status change through `set_estimate_status_atomic`; render only legal transitions; disable conversion buttons in flight and when `converted_invoice_id`/`converted_sales_order_id` is set.
- Single totals helper shared by create and edit, additional costs included in both; persist additional costs on edit.
- Retire the inline create path in favour of `EstimateCreatePage`.

**Phase 5 — expiry**
- A `pg_cron`-driven RPC that moves `sent`/`viewed` estimates past `expiry_date` to `expired` through the same state machine.

**Phase 6 — tests**
- SQL tests: conversion parity (estimate total == invoice/SO total, additional costs and UoM carried), double-conversion rejected, illegal transitions rejected.
- Architecture guards: no client-side `status` write to `estimates`; one numbering philosophy; no second conversion engine.

## 6. Regression risk

- Adding `invoices.source_estimate_id` is additive; the invoice list/record queries use `*` and are unaffected.
- The status-write trigger will break any code path still writing `status` directly — Phase 4 lands in the same change set, and the guard test enumerates the call sites.
- Changing SO numbering affects only *new* numbers; existing rows are untouched, and the old signature keeps working.
- Dropping legacy `estimate_items` policies narrows access to the parent's rule; verified against the same helper the parent uses.

## 7. Do not touch

`services/documents/snapshots/salesEstimate.ts` and its tests; the estimate print/PDF pipeline; `estimates` RLS and the branch/business match trigger; line-level snapshot semantics; the no-GL-posting boundary; `convert_lead_to_estimate`.

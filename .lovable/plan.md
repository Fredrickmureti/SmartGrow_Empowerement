# 3PL Billing Platform — Audit Verdict and Engineering Plan

## Verdict: the billing module cannot bill. It is a demo, not a platform.

Everything below was verified this turn against the live database and the source, not inferred.

| Claim | Verified state | Evidence |
|---|---|---|
| Invoice generation works | **Impossible — hard SQL error on every call.** `generate_3pl_invoice` inserts `invoice_items (invoice_id, description, quantity, unit_price, subtotal, total)`, but `invoice_items` has no `subtotal` and no `total` column (it has `line_total`, `tax_rate`, `tax_amount`, `business_id`). Column does not exist → 42703 every time. | live `information_schema` column list for `invoice_items` |
| Invoice shell is valid | **No.** `invoices.business_id` is `NOT NULL` with no default; the RPC inserts only `organization_id`. Not-null violation even if the line insert were fixed. | live `information_schema` (invoices NOT NULL set) |
| Client attribution works | **No.** 30 `warehouse.*` events exist in `business_event_outbox`; **0** carry `client_business_id` in the payload. No emitter anywhere writes that key. So every captured row lands with `client_business_id IS NULL`, while `generate_3pl_invoice` filters `client_business_id = p_client_business_id` → the query matches nothing → "no billable activity in period". | outbox count query; `rg client_business_id supabase/migrations` (only the billing migrations mention it) |
| Ledger has data | **Empty.** 0 rows in `wms_billable_activities`, 0 rows in `wms_billing_tariffs`. Nothing has ever been billed. | live counts |
| Invoice numbering is safe | **No.** Number is hand-built as `3PL-YYYYMM-<client6>`, bypassing the canonical `generate_invoice_number(org, business, branch)` RPC (advisory-locked, branch-aware). `invoices` is UNIQUE on `(organization_id, invoice_number)`, so a second invoice for the same client in the same month is a duplicate-key failure — no mid-month, corrective, or per-warehouse billing is possible. | `supabase/migrations/20260427113638…sql` numbering RPC; unique constraint |
| Tax handled | **No.** The RPC never writes `tax_amount`, never reads `contacts.default_tax_rate_id` (the canonical path is `fetchContactDefaults`), and never sets `branch_id`. A 3PL charge is a taxable service in nearly every jurisdiction. |
| AR party is correct | **No.** The UI never passes `p_contact_id`, so the invoice is created with `contact_id = NULL` — an AR document with no customer: invisible to aging, dunning, statements, and payment allocation. Clients are also modelled as sibling **businesses**, not **contacts**, and nothing maps one to the other. | `BillingBoard.tsx` `generateInvoice` mutation; RPC signature |
| Multi-currency safe | **No.** Rates are per-tariff free text; the generator picks one currency and *silently drops* every activity row in any other currency (`COALESCE(currency, v_currency) = v_currency`). No FX rate is stamped on the invoice. Revenue disappears with no warning. |
| Unpriced activity surfaced | **No.** When no tariff matches, the row is written with `tariff_id`, `unit_rate`, `amount` all NULL and no exception is raised anywhere. Work is performed, recorded, never invoiced, and nobody is told. |
| Storage accrual correct | **Partly.** `wms_accrue_storage_days` is idempotent and permission-checked, but it counts license plates by `status IN ('stored','quarantined')` **as of now** with `created_at <= cutoff` — it cannot reconstruct occupancy for a past date, so back-dated accrual is wrong. It also always attributes to the default (NULL-client) tariff, so no 3PL client is ever charged storage. |
| Finance integration | **Absent.** No revenue accrual JE for unbilled activity, no fiscal-period check, no credit-note/reversal path, no immutability trigger on the ledger (only the absence of write grants). |

## What this plan builds

Five phases, one migration and one guard test each. Each phase ends green on `bunx vitest run src/test/architecture/wms-*.test.ts` plus typecheck, and the evidence is recorded back into this file.

### Phase 1 — Make the invoice path actually execute (blocking)
- Rewrite `generate_3pl_invoice`: insert `invoice_items (invoice_id, business_id, description, quantity, unit_price, line_total, tax_rate, tax_amount, sort_order)`; set `business_id` and `branch_id` on `invoices`; allocate the number through `generate_invoice_number`; require a billing contact (see Phase 2) and reject a NULL one; compute tax from the contact's default tax rate and roll it into `tax_amount`/`total`.
- Guard: an architecture test that parses the RPC body and asserts every column it writes exists in `src/integrations/supabase/types.ts` for that table, and that it calls `generate_invoice_number`. This is the class of bug that shipped twice; the guard closes the class, not the instance.

### Phase 2 — Client identity: one client, one billing party
- Add `wms_billing_clients`: `(business_id, client_business_id NULL, contact_id NOT NULL, code, is_active)` — the mapping from a warehouse client to its AR contact, currency, and default tariff set. This is the missing spine: tariffs, activities, and invoices all key off it.
- Repoint `wms_billing_tariffs.client_id` and `wms_billable_activities.client_id` at it (keeping `client_business_id` as a deprecated shadow for one release), and make `generate_3pl_invoice` resolve the contact from the client row instead of an optional parameter.
- `BillingBoard` gains a Clients tab (contact picker + code + currency) and drops the "sibling businesses as clients" model.

### Phase 3 — Attribution: get the client onto every event
- Client on stock: add `client_id` to `wms_license_plates` and `wms_receiving_sessions`, defaulted from the inbound ASN/PO's client, and include it in the `warehouse.*` emit payloads (`_wms_emit_task_event` and the receipt/manifest/QC/count emitters).
- `capture_billable_activity` resolves the client from the payload, and falls back to the LPN's client rather than to NULL.
- Guard: extend `wms-billable-activity-completeness.test.ts` to assert every mapper-branch topic's emitter writes `client_id` and `quantity` into the payload — a mapper branch that can never match a priced tariff is a defect.

### Phase 4 — Pricing correctness
- Contract-shaped tariffs: add `min_charge`, `included_quantity`, `tier_from`/`tier_to` so the resolver can price banded and minimum-charge deals; resolve on `(client, activity, uom, date, tier)` with the client row overriding the default.
- Currency discipline: tariff currency must be an enabled `business_active_currencies` row (validation trigger); the generator raises on mixed currencies inside one period instead of silently dropping rows; stamp the FX rate used on the invoice.
- Unpriced exception: when no tariff resolves, `capture_billable_activity` still writes the row (so the work is not lost) **and** raises a `wms_exceptions` entry of type `billing_unpriced`, surfaced in the Exceptions inbox and as an "unpriced activity" counter on `BillingBoard`.

### Phase 5 — Finance-grade ledger
- Immutability trigger: block `UPDATE`/`DELETE` on `wms_billable_activities` except stamping `invoice_id`; reversal is a new negative-quantity row keyed to the original, never an edit.
- Period discipline: refuse to generate an invoice whose issue date falls in a closed `fiscal_periods` row; refuse to capture activity into a closed period.
- Unbilled revenue accrual: a monthly RPC posting the accrued-but-uninvoiced total to a WIP revenue account, reversed when the invoice is generated.
- Daily `pg_cron` schedule for `wms_accrue_storage_days` + `capture_pending_billable_activities`, and rewrite the storage snapshot to read a point-in-time occupancy from `wms_lpn_events` so back-dated accrual is correct and per-client.

## Technical notes
- Everything stays in the established WMS pattern: ledger writes only through `SECURITY DEFINER` RPCs, no PostgREST write grants on `wms_billable_activities`, events only via `business_event_outbox` triggers, one migration per phase, legacy paths replaced in the same change rather than layered.
- `src/integrations/supabase/types.ts` is regenerated after each migration, so the phase's TS work lands after its migration is approved.
- Phases 1 and 2 are prerequisites for anything else — until they land, the module cannot produce a single invoice.

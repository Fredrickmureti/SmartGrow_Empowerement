# 3PL Billing — verification verdict, then Phases 4 and 5

## Phase 1 — What I verified this turn (by execution, not assumption)

| Prior claim | Verdict | Evidence |
|---|---|---|
| Phase 1 — invoice path executes | **Confirmed** | `generate_3pl_invoice(p_business_id, p_client_id, p_period_from, p_period_to, p_branch_id, p_currency)` exists live with the client-keyed signature; guard suite `wms-3pl-billing-contract.test.ts` (6 tests) green. |
| Phase 2 — client identity spine | **Confirmed (beyond the log's claim)** | `wms_billing_clients` exists with 1 row, unique on `(business_id, code)` and `(business_id, contact_id)`; `wms_billing_tariffs`/`wms_billable_activities` carry `client_id` with `client_business_id` retained as a commented deprecated shadow. |
| Phase 3 — client attribution on events | **Confirmed** | Migration `20260803215508` adds `client_id` to license plates, receiving sessions, loading manifests and trailer visits, plus `_wms_resolve_client_id` (payload → LPN → aggregate → referenced doc) wired into `_wms_emit_event`. |
| "Landed phase 1" (progress note) | **Stale/understated** | Phases 2 and 3 also landed; the note was never updated. |
| Guard suite green | **Confirmed** | `wms-3pl-billing-contract.test.ts` + `wms-billable-activity-completeness.test.ts` → 11 tests passing. |
| BillingBoard rebuilt as an operational board | **Confirmed** | 787-line board with Clients, tariffs, ledger rollup, "Accrue storage" action, and unpriced/unbilled KPI counters reading a rollup view. |

### Genuinely open (verified absent in the live database)

- No `min_charge` / `included_quantity` / `tier_from` / `tier_to` on `wms_billing_tariffs` — no banded or minimum-charge contracts.
- No triggers at all on `wms_billable_activities` — the ledger is not immutable; only the absence of write grants protects it.
- `generate_3pl_invoice` contains no fiscal-period check — invoices can be issued into a closed period.
- `capture_billable_activity` never raises a `wms_exceptions` row — unpriced work is still silent at the source (the board counts it, but nothing escalates).
- No currency validation against `business_active_currencies`, no FX rate stamped on the invoice, mixed currencies still dropped silently.
- `pg_cron` is installed but nothing is scheduled — storage accrual and event capture only run when an operator clicks.
- Ledger is empty (0 tariffs, 0 activities), so nothing is proven end to end by data yet.

## Phase 2 — Work plan (resume at Phase 4)

### Phase 4 — Pricing correctness
- Extend `wms_billing_tariffs` with `min_charge`, `included_quantity`, `tier_from`, `tier_to`; rewrite the resolver to pick on `(client, activity, uom, date, quantity band)`, client row overriding the default, and apply included-quantity then minimum-charge in that order.
- Currency discipline: validation trigger requiring a tariff's currency to be an enabled `business_active_currencies` row; `generate_3pl_invoice` raises on mixed currencies within a period instead of dropping rows, and stamps the FX rate it used on the invoice.
- Unpriced exception: when no tariff resolves, still write the activity row (work is never lost) **and** raise a `wms_exceptions` entry of type `billing_unpriced` so it lands in the operator's Exceptions inbox, not just a KPI tile.
- Guard: extend the contract test to assert every tariff resolution path honours tier bounds and that no code path drops a priced row.

### Phase 5 — Finance-grade ledger
- Immutability trigger on `wms_billable_activities`: block `UPDATE`/`DELETE` except stamping `invoice_id`; corrections are new negative-quantity rows keyed to the original.
- Period discipline: refuse to invoice into a closed `fiscal_periods` row; refuse to capture activity into a closed period.
- Unbilled revenue accrual: monthly RPC posting accrued-but-uninvoiced totals to a WIP revenue account, reversed when the invoice is generated.
- Scheduling: daily `pg_cron` jobs for `wms_accrue_storage_days` and `capture_pending_billable_activities`; rewrite the storage snapshot to reconstruct point-in-time occupancy from `wms_lpn_events` so back-dated accrual is correct and per-client rather than default-tariff only.
- Guard: assert the ledger has an immutability trigger and that the invoice generator references `fiscal_periods`.

### Phase 6 — Dispute and credit path
- Dispute state on an activity row (`disputed_at`, reason, resolver) with an RPC transition; disputed rows are excluded from invoice candidates.
- Post-invoice correction issues a canonical credit note against the same AR contact, never an edit of the invoice.

## Technical notes
- One migration per phase; ledger writes only through `SECURITY DEFINER` RPCs; no PostgREST write grants on `wms_billable_activities`; events only via `business_event_outbox` triggers.
- `src/integrations/supabase/types.ts` regenerates after each migration, so TS work in a phase lands after that phase's migration.
- A phase is green only when the full `wms-*` guard suite plus typecheck pass, and this file records the actual output as evidence.

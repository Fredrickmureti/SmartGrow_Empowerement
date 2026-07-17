# ADR 0082 — WMS 3PL Activity-Based Billing

**Status:** Accepted
**Date:** 2026-07-17
**Supersedes:** —
**Related:** ADR 0076 (Stock event fabric), ADR 0079 (Inventory vs Warehouse split), ADR 0080 (Yard management), ADR 0081 (Labour management).

## Context

Multi-tenant warehouses (3PLs) must invoice their clients for
handling activity: receipts, put-aways, picks, packs, shipments,
storage, yard dwell, QC, etc. The WMS already emits `warehouse.*`
events onto `business_event_outbox` at every state transition
(Phases 2-10). We need a billing layer that (a) turns those events
into a priced ledger, (b) is idempotent so the same event never
double-charges, and (c) hands aggregated line items to Sales as a
draft invoice for the finance user to review and send.

## Decision

Introduce two new tables and three RPCs, all business-scoped and
following the same RPC-only ledger pattern used elsewhere in WMS.

### Tables

- **`wms_billing_tariffs`** — master data. `(business_id,
  client_business_id, activity, uom, effective_from)` is UNIQUE.
  `client_business_id` NULL is the default/fallback rate; a
  client-specific row overrides it. PostgREST writes are gated by
  `inventory:write` module permission.
- **`wms_billable_activities`** — RPC-only ledger.
  `(business_id, source_event_id)` is UNIQUE to guarantee
  idempotency. `invoice_id` is stamped when the row is folded into
  a draft Sales invoice.

### RPCs (all `SECURITY DEFINER`)

- **`capture_billable_activity(event_id)`** — reads one
  `business_event_outbox` row, maps its `event_type` to an activity
  code via `_wms_map_event_to_activity`, resolves the best-matching
  active tariff (client-specific first, then default; within the
  `effective_from` / `effective_to` range), and appends a priced
  ledger row. If a row for the same event already exists, returns
  it unchanged.
- **`capture_pending_billable_activities(business_id, limit)`** —
  bulk drain, called from the BillingBoard UI ("Capture events"
  button) or by a future scheduled worker. Skips events that are
  already captured or that have no matching activity code.
- **`generate_3pl_invoice(business_id, client_business_id,
  period_from, period_to, contact_id?, currency?)`** — aggregates
  unbilled activity in `(activity, uom, unit_rate)` groups, creates
  one `invoices` row (`status='draft'`) with one `invoice_items`
  row per group, and stamps `invoice_id` back onto every included
  activity row. Raises when there is nothing priced to bill.

### Event mapping

`_wms_map_event_to_activity` is a pure IMMUTABLE SQL function so
Postgres can inline it in the `capture_pending_*` drain query. The
initial mapping is intentionally conservative — only events that
already exist in the outbox from Phases 2-9 are billable. Storage
fees (`storage_lpn_day`) are reserved as an activity code but not
yet emitted; a scheduled job will insert those rows in Phase 12+.

### Invoice ownership

The draft invoice lives in `public.invoices`, the same table Sales
uses. This is deliberate: the 3PL charge is a real receivable
against the warehouse's client, and it must flow through the same
AR aging / dunning / payment allocation as any other invoice.
`invoice_number` uses the prefix `3PL-YYYYMM-<client8>` so it is
visually distinct in the Sales inbox.

## Consequences

- 3PL billing is now event-sourced: fixing a mis-priced tariff
  and re-running `capture_pending_billable_activities` on a fresh
  event replays cleanly because of the `(business_id,
  source_event_id)` UNIQUE constraint.
- The Sales module inherits 3PL invoices for free; no separate
  billing module was introduced.
- The `_wms_map_event_to_activity` function is the single source of
  truth for "which events are billable". Future phases (kitting,
  returns, VAS) extend it via a new migration rather than touching
  the RPCs.
- Client attribution today reads `client_business_id` from the
  event payload. Warehouses that host multiple 3PL clients must
  ensure emitting RPCs include that field (a follow-up cleanup;
  today most `warehouse.*` events omit it and fall back to the
  default tariff).

## Alternatives considered

- **Separate `billing_invoices` table.** Rejected: duplicates AR
  workflows, forces a second dunning surface, and confuses the
  finance user.
- **Trigger-based capture on `business_event_outbox`.** Rejected:
  the outbox is high-traffic and event ordering matters; an
  explicit `capture_pending_*` drain (called by UI or scheduler)
  keeps the hot insert path lean.
- **Storing the rate on the activity row without a tariff FK.**
  Rejected: we need `tariff_id` to audit which rate applied and to
  re-price historical activity by inserting a superseding tariff.

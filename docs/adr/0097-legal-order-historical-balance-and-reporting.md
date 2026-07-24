# ADR-0097 — Legal Order Historical Balance & Reporting Contract

Status: Accepted (Phase 8, step 1–3)
Depends on: ADR-0092 (event integration surfaces), ADR-0094 (event integration
contract), ADR-0096 (remittance cycle)

## Context

Phases 1–7 delivered the intake → accrual → remittance → bank-reconciliation
loop for legal orders. Auditors, controllers and jurisdiction packs now need
three things the operational surfaces cannot answer on their own:

1. A single time-ordered story of *everything* that happened to a legal order
   (status transitions, audit-log entries, notification dispatches, remittance
   milestones) — without querying five tables by hand.
2. A stable point-in-time balance for backdated statements, re-opened periods,
   and reconciliation with the general ledger.
3. A place to declare statutory reports as data (not code) so jurisdiction
   packs can register report shapes without touching the engine or UI.

## Decision

### 1. Unified audit projection

- `public.v_legal_order_audit_timeline` — a plain `VIEW` declared with
  `WITH (security_invoker = true)`. It unions five sources into one shape
  `(organization_id, legal_order_id, occurred_at, entry_kind, action,
  actor_user_id, details jsonb, source_row_id, source_table)`:
    - `garnishment_lifecycle_events` (FSM transitions)
    - `garnishment_audit_log` (mutation audit)
    - `legal_order_event_dispatch_log` joined to lifecycle events (notifications)
    - `legal_order_remittance_batches` × `legal_order_remittance_batch_lines`
      emitted three times per batch: created / settled / cancelled.
- Read-only. `GRANT SELECT ... TO authenticated`. RLS is enforced on the
  underlying tables — the projection is invoker-scoped so no user ever sees a
  row they cannot already query directly.

### 2. Statutory report definitions

- `public.legal_order_statutory_report_definitions` — one row per
  `(scope, jurisdiction_code, report_code)`. Scope is expressed by the
  nullable `organization_id`:
    - `NULL` → platform-wide definition shipped by a jurisdiction pack.
    - `NOT NULL` → org-authored override or bespoke report.
- Two partial unique indexes enforce the scope split so both universes have
  their own uniqueness guarantee.
- `definition JSONB` holds the pack-neutral spec consumed by the reporting
  centre. Fields on the row: `frequency` (`daily|weekly|monthly|quarterly|annual|ad_hoc`),
  `name`, `description`, `is_active`.
- Access: `authenticated` may read any row whose scope they belong to (or any
  platform row). Only org `owner`/`admin` may create, edit or delete rows
  within their organization; platform rows are managed by migrations only.

### 3. Point-in-time balance RPC

- `public.legal_order_running_balance(_organization_id uuid,
  _legal_order_id uuid, _as_of date default current_date)`
- `SECURITY DEFINER STABLE`. Enforces org membership via `is_org_member` and
  raises `42501` on denial. `EXECUTE` granted to `authenticated` only.
- Returns `(legal_order_id, as_of, total_owed, accrued, remitted,
  outstanding, last_accrual_at, last_remittance_at)`.
- Definition of "as of":
    - `accrued` = `SUM(garnishment_ledger.amount)` where `payment_date <= _as_of`.
    - `remitted` = `SUM(batch_lines.actual_amount)` where the parent batch is
      settled *and* `settled_payment_date <= _as_of`. Cancelled batches never
      contribute (their lines are excluded by construction).
    - `outstanding` = `max(0, coalesce(total_owed, accrued) - remitted)`.
      Falling back to `accrued` when `total_owed` is unknown keeps
      revolving-order support forward-compatible with ADR-0096.
- Deterministic across replays: no `now()` reads inside the computation.

## Consequences

- Auditors get a single query for the complete story of any legal order.
- Backdated statements and re-opened periods are safe: the RPC is a pure
  function of the committed ledger and settled batches at that date.
- Jurisdiction packs can register statutory reports declaratively; the engine
  and UI stay pack-agnostic.
- Every subsequent audit source (dispute log, correspondence log, …) plugs in
  by extending `v_legal_order_audit_timeline` with another `UNION ALL` branch
  — no consumer contract changes.

## Non-goals

- No writer paths from the Audit surface. All state changes continue to route
  through the FSM (`apply_system_garnishment_transition`).
- No PDF/CSV emission in this ADR. Reporting-centre packaging remains
  ADR-0093 territory.

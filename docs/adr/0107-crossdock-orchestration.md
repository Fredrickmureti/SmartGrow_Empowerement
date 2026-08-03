# ADR 0107 — Cross-dock Orchestration Engine

**Status:** Accepted (2026-08-03) · **Supersedes:** the cross-dock half of ADR 0083 ·
**Related:** 0079 (Inventory/WMS split), 0080 (Yard/dock), 0101 (FSM + event catalog).

## Context

The ADR 0083 cross-dock implementation was a *match log*, not an engine:

- Three statuses (`open|staged|cancelled`); no qualification, execution or failure states.
- Hardcoded FIFO match to the single oldest sales-order line; one match per receipt line.
- Only disqualifier was an open QC hold. No shelf life, quantity, cut-off or policy input.
- `confirm_crossdock_stage` moved a status and emitted an event — it created no work,
  reserved nothing, and never touched dock scheduling.
- No expiry: a match could sit open forever after its ship window closed.
- The page called RPCs directly, violating the aggregate-wrapper rule in
  `docs/architecture/WMS_MODULE_OWNERSHIP.md`.

## Decision

### 1. Lifecycle
`wms_crossdock_state`: `detected → qualified → approved → staging → staged →
loaded → completed`, with `rejected`, `expired`, `broken`, `cancelled` as terminals.
Every row carries `row_version`; the legacy `status` column is a trigger-maintained
mirror so existing consumers keep working. `wms_crossdock_history` is an append-only
audit of every transition.

### 2. Qualification engine
`wms_crossdock_rules` (per business, optionally per warehouse) drives
`_wms_crossdock_detect(...)`: shelf life, lot/serial policy, QC pass, quantity
bounds, cut-off window and full-line requirement. Failures are persisted as
`rejected` with a reason rather than dropped silently.

Demand candidates now include **sales order lines and outbound transfer lines**,
ordered by cut-off. A single receipt line splits across multiple demand lines until
its quantity is exhausted. Score = urgency + fill completeness + full-line bonus;
score ≥ `auto_approve_score` auto-approves.

### 3. Orchestration
`wms_crossdock_approve / _reject / _start_staging / _confirm_staged / _mark_loaded /
_complete / _break` are the only writers of `state`. They resolve the outbound
staging lane, create the `move` task to staging and the `load` task off the staging
lane, close/cancel those tasks on completion or break, and raise a `wms_exceptions`
row when a plan breaks. `wms_crossdock_sweep_expired()` runs hourly via pg_cron.

### 4. Boundaries
Cross-dock still owns **no** stock ledger writes — Receiving (Phase 2) and Dispatch
(Phase 5) remain the only movement writers. Cross-dock decides and directs; it does
not post inventory.

### 5. Client contract
`src/features/warehouse/crossdock/useCrossdock.ts` is the sole client entry point;
`CrossdockBoard` is a decision center (lanes: awaiting decision / in execution /
closed) and calls no RPC directly. Guarded by `wms-phase12.test.ts`.

## Non-goals

- Cross-warehouse cross-dock (still ADR 0083 Phase 14).
- Automatic carrier cut-off derivation from carrier services — cut-off currently comes
  from the demand document's expected date.
- Opportunistic re-matching when a better order arrives after approval.

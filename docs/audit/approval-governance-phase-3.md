# Approval & Governance Consolidation — Phase 3

**Status:** Shipped.
**Follow-up to:** Phase 2 (versioning, snapshots, hash-chained history, FK cutover).

## Scope

Phase 3 introduces the two canonical database entry points that every
module must use to interact with the approval engine, and locks down
direct writes so no module can bypass them.

## Delivered

### DB — single entry points
- `public.approval_route(action_key, entity_type, entity_id,
   entity_reference, payload, context, idempotency_key, business_id)`
  - Validates `action_key` against `governance_action_registry` (raises
    `GOV_UNKNOWN_ACTION`).
  - Resolves the org from `context.organization_id` or membership.
  - Idempotency: replays with the same `(organization_id,
    idempotency_key)` return the existing request row unchanged.
  - Collapses duplicate open requests for the same subject
    (`entity_type, entity_id, action_key`).
  - Matches the first active `approval_rules` row (business-scoped rows
    win, threshold operators `>=,>,<=,<,=` supported) via
    `_approval_match_rule` and snapshots the matched rule into
    `context_snapshot.matched_rule_snapshot`.
  - Inserts a `routed` event into `approval_history` (hash-chained by
    the Phase 2 trigger) and emits `approval.routed` on the
    `business_event_outbox` (best-effort).
- `public.approval_decide(request_id, decision, comment)`
  - Rejects unknown decisions and decisions on terminal requests
    (`GOV_TERMINAL_STATE`).
  - Blocks self-approval by delegating to
    `governance_assert_not_self(...)` so mode-tier semantics and
    single-use overrides from Waves G2-G5 apply automatically.
  - Transitions status to `approved | rejected | cancelled`, writes
    the decision to `approval_history`, and emits
    `approval.<terminal>` on the outbox.

Both RPCs are `SECURITY DEFINER`, `search_path=public`, and grant
`EXECUTE` to `authenticated` + `service_role` only.

### DB — write lockdown
`INSERT/UPDATE/DELETE` on `approval_requests` and `approval_history` is
revoked from `authenticated` and `anon`. `SELECT` remains (RLS still
filters). `service_role` retains full access for edge functions and
integrity monitors.

### App — canonical client helper
- `src/lib/governance/approvalEngine.ts` exposes `routeApproval`,
  `decideApproval`, and `verifyApprovalHistory`. This is the only
  module allowed to embed the RPC names.

### Architecture guards
- `src/test/architecture/approval-engine-entrypoints.test.ts` pins:
  - Both RPCs exist with the correct grants.
  - Direct writes on `approval_requests` / `approval_history` are
    revoked in the same migration.
  - No file outside `src/lib/governance/approvalEngine.ts` embeds the
    RPC name — regressions fail the build.

## Verified
- Migration applied cleanly. Linter warnings are all pre-existing
  (2267 issues, unchanged category mix from Phases 1-2).
- No existing rows in `approval_requests` / `approval_history` — write
  lockdown carries no cutover risk.

## Not in scope for Phase 3
- Multi-step workflows (`approval_workflow_steps.current_step`
  advancement). Current router creates single-step requests; Phase 4
  will introduce multi-step decisioning when the first migrating
  module (App Access) needs it.
- Delegation graph and escalation SLAs — deferred to Phase 6 with the
  security hardening pass.

## Next
Phase 4 — migrate the first bespoke approval hook onto the engine.
Start with **App Access** (`useAppAccessRequest` + `AppAccessApprovalsInbox`)
because it is the most self-contained surface and touches no financial
posting.

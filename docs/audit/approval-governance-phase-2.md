# Approval & Governance Consolidation — Phase 2

**Status:** Shipped.
**Follow-up to:** Phase 1 (`governance_action_registry` + soft trigger on
`approval_rules.action_name`).

## Scope

Phase 2 hardens the approval-engine schema so the single-entry-point
RPCs planned in Phase 3 (`approval.route` / `approval.decide`) can be
built on stable, tamper-evident foundations. All target tables were
empty pre-migration, so the cutover carried no data-migration risk.

## Changes

### `approval_workflows` — versioning
- `version int NOT NULL DEFAULT 1`
- `is_published boolean NOT NULL DEFAULT false`
- `published_at`, `published_by`, `superseded_by → approval_workflows(id)`
- `definition_hash text` (Phase 3 will populate on publish)
- Partial index on published rows per org.

Rule/workflow edits will always produce a new version row. In-flight
requests reference the version they were routed against so policy
changes never rewrite history.

### `approval_workflow_steps`
- Optional `action_key` FK into `governance_action_registry`, so a
  step can declare "this step decides `bill.approve`" for downstream
  UI filtering and auditing.

### `approval_requests` — snapshots + idempotency
- `action_key text` FK → `governance_action_registry.action_key`
- `workflow_version int`, `policy_version int`
- `payload_snapshot jsonb`, `context_snapshot jsonb` (immutable copies
  of the request payload and evaluator context at route time)
- `idempotency_key text` with `UNIQUE(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL` — duplicate submissions from
  clients or event replays return the same request row.
- `dedupe_hash text` for deterministic duplicate detection when a
  caller can't provide a client-side idempotency key.
- `updated_at` + touch trigger.

### `approval_history` — hash-chained tamper-evident log
- `event_type`, `actor_user_id`, `payload jsonb`, `event_seq`,
  `prev_hash`, `event_hash`, `recorded_at`.
- BEFORE INSERT trigger `_approval_history_chain` computes a
  per-request monotonic `event_seq`, links `prev_hash` to the previous
  event and hashes `(request, seq, type, action, actor, prev_hash,
  payload, recorded_at)` with SHA-256.
- BEFORE UPDATE/DELETE guard raises `SQLSTATE 42501` +
  `HINT GOV_APPEND_ONLY` on any mutation to the hash-carrying columns.

### `approval_rules` — hard FK cutover
- Phase 1's soft trigger `trg_approval_rules_registry_check` is
  dropped and replaced with a real foreign key
  `approval_rules_action_name_fk → governance_action_registry(action_key)`.
- Unknown action keys are now rejected at write time.

### `approval_history_verify(uuid)` — integrity RPC
- SECURITY DEFINER, STABLE. Recomputes the chain and returns
  `(event_seq, ok, reason)` per event. Grants restricted to
  `authenticated` + `service_role`. Used by the Governance surface to
  render a "chain verified" badge and by future integrity monitors.

## Guards added
- `src/test/architecture/approval-engine-schema.test.ts` — asserts
  every Phase 2 invariant is present in the migration file so future
  edits cannot silently regress the schema.

## What's next (Phase 3)
- Introduce `approval.route(action_key, payload, context, idempotency_key)`
  and `approval.decide(request_id, decision, comment)` RPCs as the
  single entry points, revoke direct writes to `approval_requests` /
  `approval_history` from `authenticated`, and start migrating module
  hooks (`useSalesOrderApproval`, `useAppAccessRequest`, bills, POs,
  refunds…) onto the central engine.

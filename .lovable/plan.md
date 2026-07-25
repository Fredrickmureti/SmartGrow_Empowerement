
# Approval & Governance Consolidation — verification result and continuation

## Phase 1 — Verification of the previous engineer's claims (done, evidence below)

Checked against the live database and the code, not the log.

**Genuinely complete**
- `governance_action_registry` exists with exactly 43 action rows; hard FK from `approval_rules.action_name`.
- `approval_route`, `approval_decide`, `approval_history_verify`, `governance_assert_not_self` all exist as SECURITY DEFINER functions.
- Direct `INSERT/UPDATE/DELETE` on `approval_requests` and `approval_history` are revoked from `authenticated` and `anon` (verified via `has_table_privilege`).
- Client helper `src/lib/governance/approvalEngine.ts` plus the three architecture guard tests exist and encode the intended rules.

**Claimed complete but materially incomplete — reclassified as pending**

1. **No approver authority check anywhere.** `approval_decide` verifies only that the caller is authenticated, that the request is not terminal, and that the caller is not the requester. Any signed-in user of any tenant can approve any request in the table, including another organization's. This is a privilege-escalation and cross-tenant hole, not a Phase 6 nicety.
2. **`approval_route` trusts caller-supplied `organization_id`.** When `_context.organization_id` is present it is used without confirming the caller is a member. Requests can be planted into other tenants.
3. **The workflow engine does not exist.** `approval_route` inserts `workflow_id = NULL`, hardcodes `workflow_version = 1`, and never reads `approval_workflows` / `approval_workflow_steps`. `approval_decide` terminalizes on the first decision. Multi-step, sequential, quorum and escalation approvals — the reason the schema exists — are unimplemented.
4. **Rule matching has no "no approval required" outcome.** If `_approval_match_rule` finds nothing, a pending request is still created, so a module routing every event would block work that policy does not gate.
5. **Snapshots are not what Phase 2 promised.** There are no `rule_snapshot` / `workflow_snapshot` columns; the matched rule is stuffed into `context_snapshot`. `approval_history` is missing the `event_seq` column the verify RPC and the hash chain design assume.
6. **Decision replay protection is absent.** No `client_token`, no unique index on `(request_id, step_id, client_token)`, contrary to the plan's Phase 2/3 notes.
7. **Outbox emission swallows every error** (`EXCEPTION WHEN OTHERS THEN NULL`) in both RPCs, so downstream execution can be silently lost with no dead-letter row.
8. **Phase 4 has not started at all.** No file in `src/` calls `routeApproval`/`decideApproval`. All bespoke surfaces are intact: `useApprovalGate` (+ `approval_rule_logs`, still directly INSERT/UPDATE-able by `authenticated`, with rule evaluation done in the browser and therefore bypassable), `useAppAccessRequest`, `AppAccessApprovalsInbox`, `useSalesOrderApproval`, `useProcurementRecommendations`, `PayrollControlCenter`, `ApprovalStatusBanner`, `PendingApprovalsWidget`.

## Phase 2 — Revised roadmap

The original phase order stands, but Phase 4 cannot begin on top of an engine that lets anyone approve anything. A new Phase 3b is inserted ahead of module migration, and the Phase 6 security items that are actually correctness bugs are pulled forward into it.

### Phase 3b — Engine correctness and authority (do first)
- **Authority model.** Add `approval_request_approvers` (request, step, approver principal — user, role, or permission group, resolved at routing time from the matched rule/workflow) and a `approval_can_decide(request, user)` security-definer predicate. `approval_decide` refuses with `42501` unless the caller is an eligible approver for the *current* step and a member of the request's organization.
- **Tenant isolation.** `approval_route` validates the caller's active membership of the resolved organization instead of trusting context; same membership assertion in `approval_decide`.
- **Real workflow instancing.** Route resolves rule → workflow → steps, snapshots them into new `rule_snapshot` / `workflow_snapshot` columns, sets `workflow_id`/`workflow_version` from the live definition, and creates step approver rows. Decide advances `current_step`, records per-step history, and only terminalizes when the last step approves (a reject or cancel terminalizes immediately). Quorum (`min_approvals`) honoured per step.
- **No-rule path.** Route returns a `not_required` outcome (no request row) when no active rule matches, so modules can call it unconditionally.
- **Replay + immutability.** Add `client_token` with the unique index, `event_seq` on `approval_history`, and enforce the hash chain over `(prev_hash, event_seq, request, step, decision, actor, decided_at)`.
- **Outbox reliability.** Stop swallowing errors: emit inside the transaction and let a failure roll the decision back, or write to a dead-letter table. Register one topic per action key.
- Guard tests extended: authority refusal, cross-org refusal, multi-step advancement, replay rejection, chain continuity.

### Phase 4 — Module migration (unchanged order, one module at a time)
App Access → Expenses/Bills/POs/Credit Notes/Refunds → Journal Entries & posting → Inventory (stock adjustment, physical count) → Sales/Procurement → HR (loans, leave) → Payroll runs. Each module: emit the business event through `routeApproval`, execute on the terminal outbox event, delete its bespoke hook and pending list in the same change, add a smoke test.
- **Added item:** `approval_rule_logs` is a second request ledger. It is retired during App Access migration, its writes revoked from `authenticated`, and `useApprovalGate` deleted rather than rewritten — client-side threshold evaluation is not a gate.

### Phase 5 — Unified UI
Settings → Governance (policy only), Studio → Approvals (rule/workflow authoring, simulation), one global "My Approvals" inbox, one `<ApprovalStatusPanel />` on every object page replacing `ApprovalStatusBanner` and `PendingApprovalsWidget`. Enterprise-plain surfaces reusing existing design-system scaffolds; no new visual language.

### Phase 6 — Remaining hardening
Rate limiting on decide, delegation with loop detection, escalation SLAs and a scheduler, nightly chain-integrity monitor feeding a `governance_integrity_issues` stream, pgTAP suite.

### Phase 7 — Retirement
Delete migrated hooks/pages, the `automated_actions` approval branch, and any action key defined outside the registry; architecture tests block regressions.

## Verification gates per phase
`bun run tsgo` clean; `bunx vitest run src/test/architecture/*`; `supabase--linter` clean; DB assertions re-run (privileges, function bodies contain the authority assert); Playwright smoke on each migrated module's approve/reject path.

## Technical notes
- New objects: `approval_request_approvers`, `approval_can_decide(uuid, uuid)`, columns `approval_requests.rule_snapshot/workflow_snapshot`, `approval_history.event_seq/client_token`, unique index `(request_id, step_number, client_token)`. All new public tables ship with explicit GRANTs plus RLS scoped through existing membership helpers.
- `approvalEngine.ts` gains `stepId`/`clientToken` parameters and a `not_required` result variant; it remains the only file permitted to name the RPCs.
- Existing `governance_assert_not_self` / `_not_subject` continue to be reused verbatim — no parallel SoD implementation.

## Execution log

### Phase 3b — DONE (migration applied)
`rule_snapshot` / `workflow_snapshot` / `total_steps` on `approval_requests`;
new `approval_request_steps` + `approval_request_approvers` (RLS on, direct
writes revoked); `approval_route` rewritten (org-membership validation,
rule → workflow → step/approver materialisation, snapshotting, idempotency +
dedupe hash, `approval.routed` outbox event); `approval_decide` rewritten
(`approval_can_decide` eligibility predicate, per-step quorum advancement,
`_client_token` replay guard). Client wrapper `decideApproval` now sends a
client token.

### Phase 4.1 — App Access — DONE
- `governance_action_registry` gains `requires_approval_always`; actions
  flagged with it are routed even when no threshold rule matches (the
  "no rule = not gated" default is wrong for mandatory-approval actions).
- `app_access.grant` registered (module `Platform`). Deliberately NOT added
  to `SELF_ACTION_CATALOGUE` — that catalogue drives the self-approval
  override picker and is a subset of the registry, not a mirror.
- `request_app_access` now delegates to `approval_route` with a deterministic
  per-(user, app) `entity_id`, so repeat clicks collapse onto one request.
- Grant execution moved to trigger `trg_exec_app_access_grant`, fired by the
  terminal `approved` transition, writing `executed` / `execution_skipped`
  into the hash-chained history.
- Bespoke `approve_app_access_request` / `deny_app_access_request` dropped;
  `AppAccessApprovalsInbox` decides through `decideApproval`.
- Note: all three legacy app-access RPCs referenced columns that no longer
  exist (`request_type`, `request_data`, `approval_history.actor_id`), i.e.
  the surface was already broken at runtime before this migration.

### Next
Phase 4.2 — retire `approval_rule_logs` + delete `useApprovalGate`, then
Expenses/Bills/POs onto `routeApproval`.

### Phase 4.2 — client-side approval gate retired — DONE
- Deleted `useApprovalGate`, `ApprovalGateDialog`, `ApprovalStatusBanner`
  (browser-side threshold evaluation was bypassable; they had no other
  consumers).
- `procurement_recommendation.approve` registered; `useProcurementRecommendations`
  now calls `routeApproval` only — `routeApproval` returns `null` when policy
  does not gate the action, and triggers
  `trg_exec_procurement_rec_approval_{ins,upd}` mirror routed/decided requests
  onto the recommendation (`in_review` → `approved` / back to `open`).
- `approval_rule_logs` INSERT/UPDATE/DELETE revoked from `authenticated`/`anon`;
  it is now legacy-read-only. Remaining writer: the stock-adjustment
  SECURITY DEFINER RPCs (Phase 4.3, Inventory).
- Verified: typecheck clean; `src/test/architecture` has no approval/
  governance/procurement failures (the 106 failing tests there are
  pre-existing and unrelated).

### Next
Phase 4.3 — Inventory: move `apply_or_request_stock_adjustment` +
`physical_count` gating off `approval_rule_logs` onto `approval_route`, then
delete the table.

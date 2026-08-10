# Governance Mode Engine — Canonical Reference

This document traces how `solo` / `standard` / `strict` governance modes and
per-action self-action overrides are represented, resolved, and enforced,
and states exactly how `approval_route`, `approval_decide`, and
`governance_assert_not_self` currently interact with them.

## 1. Canonical decision function

**`public.governance_assert_not_self(p_actor, p_subject, p_action, p_org, p_entity_type, p_entity_id)`**
(latest definition: `supabase/migrations/20260725191152_cc9e95b5-f64b-426a-a8dc-2b72f17bffad.sql`,
superseding `20260611191633_bec80f4b-7a70-4817-bca7-3df5426c4fa2.sql` and the
original `20260611180840_f847bb74-...sql`)

This is the **single, DB-side canonical enforcement point** for "can this
actor act on their own record for this action." All modules that need
self-action / SoD protection are expected to call it via `PERFORM
public.governance_assert_not_self(...)`, passing the org id so mode
resolution can occur. `src/test/architecture/sod-coverage.test.ts` asserts
that registered self-action keys are actually guarded by a call to this
function inside their owning SQL function.

### Resolution order inside `governance_assert_not_self`
1. No-op if `p_actor IS NULL`, `p_subject IS NULL`, or `p_actor <> p_subject`
   (only self-action is in scope; acting on someone else always returns).
2. No-op during org teardown (`_is_teardown_for_org`).
3. Resolve `v_actor_role` (highest of `super_admin > owner > admin > other`)
   from `user_roles` for `p_org`.
4. Resolve `v_org_mode` from `organizations.governance_mode`
   (`solo|standard|strict`, default `'standard'` if null).
5. **Solo short-circuit**: if `v_org_mode = 'solo'` AND the actor holds an
   operator role (`super_admin`, `owner`, or `admin`), self-action is
   auto-allowed — an `sod.self_action_auto_allowed` audit row is written
   (reason `'solo_governance_mode'`) and the function `RETURN`s. **Note:**
   this branch keys off the actor's *role*, not the current org member
   count — unlike the intermediate `20260611191633` version, which also
   checked `member_count <= 1` before allowing. In the current
   (`20260725191152`) version, once mode is `solo`, any operator-role actor
   self-approves without a headcount re-check inside this function; the
   headcount gate lives instead in the promotion trigger (see §3).
6. Otherwise, look up an explicit override row in `self_action_policy`
   (`organization_id`, `action_key`, `applies_to_role` matching the actor's
   role, falling back to the org-wide default row where
   `applies_to_role IS NULL`).
7. If no explicit policy row exists, derive a **mode default** from
   `v_org_mode`:
   - `standard`: `owner`/`super_admin`/`admin` → `warn`; everyone else →
     `block`.
   - `strict` (or any other value): → `block`.
8. Apply the resolved mode:
   - `allow` → return silently.
   - `warn` → write `sod.self_action_warn` audit row, return (self-action
     proceeds).
   - `block` / `require_cosign` → look for a live, unconsumed row in
     `self_action_overrides` matching `(org, actor, subject, action_key,
     entity_id-or-null)` and not expired; if found, atomically consume it
     (`consumed_at`, guarded by `app.self_action_consume` session flag +
     the `self_action_overrides_immutable` trigger), audit
     `sod.self_action_override_consumed`, and return. If no override,
     `RAISE EXCEPTION 'Self-approval blocked ...' USING ERRCODE='42501',
     HINT='GOV_SELF_ACTION'`.

### Supporting tables
- `organizations.governance_mode text NOT NULL DEFAULT 'solo'` — the tenant
  setting, `CHECK (governance_mode IN ('solo','standard','strict'))`
  (migration `20260611191633_...`). Read/written by
  `src/components/settings/GovernanceModeCard.tsx` and
  `src/hooks/governance/useGovernanceMode.ts`.
- `promote_governance_mode_on_member_add()` trigger on `user_roles`
  (`AFTER INSERT OR UPDATE OF is_active`): auto-promotes `solo → standard`
  the moment a second **active** member exists, logging
  `sod.governance_mode_changed`. This is the mechanism that keeps "solo"
  tied to true single-operator orgs — mode can be demoted back to `solo`
  only via the explicit `GovernanceModeCard` UI (`organizations` UPDATE by
  an owner/super_admin), not automatically.
- `self_action_policy` — per-org, per-`action_key`, optional
  `applies_to_role` override of the mode-default (`block|warn|
  require_cosign|allow`). Owner/super_admin write-only via RLS
  (migration `20260611180840_...`).
- `self_action_overrides` — one-time, co-signed break-glass grants
  (`co_signed_by <> actor_user_id`, `reason` ≥ 12 chars, default 1h expiry,
  immutable after insert via `self_action_overrides_immutable` trigger).
  Issued from `src/components/governance/SelfActionOverrideDialog.tsx`.

## 2. Expected solo-mode self-approval behavior

**By design**, in `solo` mode:
- An org with a single operator (owner/admin/super_admin) should be able to
  self-approve **without friction**, because there is nobody else to hand
  the approval to.
- Every such auto-allow is still recorded to `audit_logs` as
  `sod.self_action_auto_allowed` (reason `solo_governance_mode`) — the mode
  never silently drops observability, only the hard block.
- The mode is not meant to be a manual, permanent choice for multi-person
  orgs: `promote_governance_mode_on_member_add()` force-upgrades to
  `standard` as soon as a second active member is added, specifically to
  prevent `solo`'s auto-allow from persisting once SoD actually matters.
- This is documented user-facing in `GovernanceModeCard.tsx`: *"While the
  organization has one active member, self-approval is auto-allowed (each
  event is still recorded in the audit log). Adding a second teammate
  automatically upgrades to Standard."*

## 3. Do `approval_route` / `approval_decide` honor this?

**`approval_route`** (`supabase/migrations/20260725191152_cc9e95b5-...sql`,
`src/lib/governance/approvalEngine.ts::routeApproval`): does **not** call
`governance_assert_not_self` at all, and does not read
`organizations.governance_mode`. Its job is purely to decide *whether an
approval request should be created* (matching `approval_rules` /
`approval_workflows`, or `governance_action_registry.requires_approval_always`)
and to persist the request/steps/approvers. It has no self-approval
concept — self/other is irrelevant at routing time.

**`approval_decide`** (`supabase/migrations/
20260725190839_5d27ea66-9678-404f-a57e-77eccf99f65e.sql`,
`src/lib/governance/approvalEngine.ts::decideApproval`): **does honor it**,
but only on the `approve` path, and only for the simple "requester ==
decider" case:

```sql
IF _decision = 'approve' AND v_req.requested_by = v_user THEN
  PERFORM public.governance_assert_not_self(
    v_user, v_user, v_req.action_key, v_req.organization_id,
    v_req.entity_type, v_req.entity_id
  );
END IF;
```

Consequences:
- ✅ **Honored**: when the same user who requested an `approval_requests`
  row tries to approve it, `approval_decide` defers entirely to
  `governance_assert_not_self`, so `solo` mode's auto-allow, `standard`'s
  role-based warn/block, `strict`'s always-block, explicit
  `self_action_policy` rows, and one-time `self_action_overrides` all apply
  uniformly here. This is the officially documented behavior (`decideApproval`
  docblock: *"Blocks self-approval through the existing governance
  framework"*), and is asserted by `sod-coverage.test.ts` /
  `governance-single-engine.test.ts`.
- ⚠️ **Not covered by this call**: `reject` and `cancel` decisions never
  invoke `governance_assert_not_self`, so a requester can reject/cancel
  their own request in any governance mode (this is treated as the
  requester's own escape hatch, gated separately by `v_req.requested_by =
  v_user OR approval_can_decide(...)`, not by SoD policy).
- ⚠️ **Not covered by `approval_route`**: nothing at routing time checks
  self-action; the gate exists solely inside `approval_decide`'s `approve`
  branch. Any caller that only calls `approval_route` and expects
  self-approval protection at creation time will not get it — the
  protection is deferred to decision time.
- Direct callers that mutate domain tables **without** going through
  `approval_route`/`approval_decide` (e.g. lifecycle RPCs like
  `physical_count_submit/approve/post`, payroll, leave, requisitions) are
  each individually responsible for calling `governance_assert_not_self`
  themselves; `sod-coverage.test.ts` enumerates the registered
  self-action keys and greps each owning function's SQL body for a call to
  `governance_assert_not_self` mentioning that key, to keep this from
  silently regressing as new lifecycle functions are added.

## 4. How a module should invoke the engine

1. **Client side**: never call `.rpc("approval_route"|"approval_decide")`
   directly — always go through `src/lib/governance/approvalEngine.ts`
   (`routeApproval` / `decideApproval`). This is enforced by
   `src/test/architecture/approval-engine-entrypoints.test.ts`, which scans
   for stray `.rpc("approval_route"...)`/`.rpc("approval_decide"...)`
   literals outside that file.
2. **New SQL lifecycle function that lets a user act on their own record**
   (approve their own leave, post their own payroll run, etc.):
   - Register the action key + entity/subject shape in
     `src/lib/governance/selfActionCatalogue.ts` (client catalogue) and
     ensure a matching row/expectation exists for it in
     `src/test/architecture/sod-coverage.test.ts`.
   - Inside the SQL function, before executing the state transition, call:
     ```sql
     PERFORM public.governance_assert_not_self(
       p_actor, p_subject, '<action_key>', p_org, '<entity_type>', p_entity_id
     );
     ```
     using the actual subject (self for plain self-approval actions, or the
     entity's owning user for `from_entity`-mode actions such as
     `expense.employee_id`).
   - Do not re-implement mode/role logic locally — the mode resolution
     (`solo` auto-allow, `standard` warn-for-operators, `strict` block-all,
     policy overrides, break-glass overrides) lives exclusively inside
     `governance_assert_not_self`.
3. **UI**: use `useGovernanceMode()` (org-wide `solo/standard/strict`
   badge/copy only) and `useSelfActionPolicy(actionKey)` (per-action
   effective mode, to decide whether to disable a button or show the
   "Request override" CTA) — both are read-only conveniences; the DB
   function remains the source of truth and re-validates independent of
   what the UI decided to render.
4. **Approvals-engine actions** specifically: call `routeApproval` to
   create/replay the request, then `decideApproval` for every decision.
   Self-approval protection is automatically applied only on `approve`;
   if a workflow needs self-`reject`/`cancel` restricted too, that must be
   added explicitly (currently it is not).

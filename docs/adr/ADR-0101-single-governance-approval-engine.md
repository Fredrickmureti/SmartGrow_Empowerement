# ADR-0101 — There is exactly ONE approval & governance engine

Status: Accepted (binding, non-negotiable)

## Decision

This system has a single approval/governance engine. It is:

- **Registry:** `public.governance_action_registry` (action keys, severity,
  `requires_approval_always`)
- **Policy:** `public.approval_rules`, `public.approval_workflows`,
  `public.approval_workflow_steps`
- **Runtime:** `public.approval_requests`, `public.approval_request_steps`,
  `public.approval_request_approvers`, hash-chained `public.approval_history`
- **Entry points:** `public.approval_route(...)` and
  `public.approval_decide(...)` — client side only via
  `src/lib/governance/approvalEngine.ts`
- **Configuration UI:** `/settings/workspace` → **Governance** (supports the
  different governance modes already shipped)

## Forbidden

Do **NOT**, under any circumstances:

1. Create a second approval engine, "approval service", per-module approval
   tables, or a parallel `*_approvals` / `*_approval_requests` table.
2. Implement threshold / limit / segregation-of-duties evaluation inside a
   feature module (browser or module RPC). Thresholds live in
   `approval_rules`, evaluated by `_approval_match_rule`.
3. Call `approval_route` / `approval_decide` directly from feature code —
   go through `src/lib/governance/approvalEngine.ts`.
4. Write to `approval_requests` / `approval_history` directly (grants are
   revoked from `authenticated`).

## How to add approvals to a new module

1. Insert an action key into `governance_action_registry`
   (`<entity>.<verb>`, e.g. `rfq.approve`).
2. From the module's submit RPC (or a client hook), call
   `approval_route(action_key, entity_type, entity_id, ...)`. A `NULL` return
   means policy does not gate the action — proceed immediately.
3. Store the returned request id on the entity (`approval_request_id`).
4. Add an `AFTER UPDATE` trigger on `approval_requests` filtered by
   `entity_type` that mirrors `approved` / `rejected` / `cancelled` back onto
   your entity. See `_mirror_approval_to_rfq()`.
5. Make the module's own "approve" RPC **refuse** while a live request exists
   (`ERRCODE 42501`, `HINT = 'GOV_USE_APPROVAL_ENGINE'`).

## RFQ reference implementation

- `rfq_submit_for_approval` → routes `rfq.approve` through `approval_route`
  and stores `rfqs.approval_request_id`.
- `rfq_approve` → ungated fallback only; refuses when a live governance
  request exists. Retains the submitter-cannot-approve backstop.
- `_mirror_approval_to_rfq` → governance decision mirrors onto the RFQ
  (`approved`, or back to `draft` on reject/cancel).

## Enforcement

`src/test/architecture/governance-single-engine.test.ts` fails the build if a
second engine is introduced.

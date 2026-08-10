# Purchasing Governance Consolidation

## Confirmed diagnosis

- The active organization (`Joshua Holdings`) is configured as `solo`; the affected user is its active `owner`. The other active membership is a `portal` user, not a governance operator.
- The canonical `governance_assert_not_self` function already implements the intended hierarchy:
  - `solo`: owner/admin self-action is allowed and audited.
  - `standard`: owner/admin self-action is allowed with an audit warning; staff is blocked.
  - `strict`: self-action is blocked unless an applicable policy or one-time override permits it.
  - `self_action_policy` provides per-action/per-role overrides, and `self_action_overrides` provides consumable exceptions.
- `approval_decide` already delegates requester self-approval to that canonical function.
- Purchase Requisitions bypass it in the ungated path: `approve_requisition` unconditionally refuses when the actor is `requester_id` or `submitted_by`. The current PR is `submitted`, belongs to the solo organization, was requested/submitted by the owner, and has no approval request; this exact branch produces the reported error.
- RFQs repeat the defect: `rfq_approve` unconditionally blocks the submitter. `rfq_award` also contains independent hard-coded submitter/approver conflicts.
- Purchase Orders repeat it before the existing mode-aware trigger can run: `approve_purchase_order` unconditionally blocks the creator/submitter, even though `sod_purchase_orders_guard` already calls `governance_assert_not_self`.
- The live `approve_bill_atomic` path also contains an unconditional creator/approver check. Other purchasing-adjacent records such as bill payments and vendor credit notes already have mode-aware trigger guards, but their live writers and action keys still need parity verification.
- The UI reinforces the wrong rule by stating that requisition self-approval is always forbidden.

## Implementation

1. **Make the canonical resolver the only purchasing SoD authority**
   - Replace unconditional actor-vs-originator refusals in `approve_requisition`, `rfq_approve`, `approve_purchase_order`, and the live bill approval writer with `governance_assert_not_self` using the registered action key, organization, entity type, and entity ID.
   - Preserve all existing authentication, business access, lifecycle, matching, and approval-request gates.
   - Keep gated decisions on `approval_decide`; ungated module RPCs will apply the same canonical governance resolution directly.

2. **Normalize RFQ award governance without weakening distinct controls**
   - Remove the hard-coded submitter/approver branches from `rfq_award`.
   - Express each intended conflict through registered governance actions and the canonical resolver, so solo/standard/strict and advanced overrides apply consistently and every exception is audited.
   - Preserve the independent `rfq.award` approval route and conversion gate; no second approval engine or module-local threshold logic will be introduced.

3. **Audit all purchasing approval writers and close sibling bypasses**
   - Cover PRs, RFQs and awards, POs, bills, bill payments, vendor credit notes, and other live purchasing approval/confirmation RPCs discovered by the writer inventory.
   - For each live path, ensure either the RPC calls the canonical resolver or a database trigger does so, with no earlier unconditional check that overrides governance mode.
   - Remove or supersede only duplicate SoD checks; retain non-SoD controls such as permissions, document state, three-way-match exceptions, posting integrity, and approval routing.

4. **Complete registry and advanced-override parity**
   - Register any missing purchasing action keys needed by the canonical checks, including RFQ approval/award relationships where distinct policies are required.
   - Add PR and RFQ entities/actions to the client governance catalogue so advanced per-role policy and one-time override screens can configure them.
   - Keep the database registry and client catalogue in exact parity through the existing architecture guard.

5. **Correct purchasing UI behavior and messaging**
   - Remove absolute copy such as “Approvers cannot approve their own requisitions.”
   - Keep actions driven by lifecycle and approval-request state: gated records direct users to Approvals; ungated records use their module RPC.
   - Parse canonical governance errors/hints so strict-mode refusals and missing approvals are presented accurately rather than as invented module rules.

6. **Regression-proof the governance contract**
   - Add database tests for PR, RFQ approval, RFQ award, PO, and bill approval across:
     - solo owner allowed and audited;
     - standard owner allowed with warning;
     - standard staff blocked;
     - strict owner blocked;
     - explicit per-action allow overriding strict;
     - one-time override consumption where applicable;
     - gated actions remaining decidable only through `approval_decide`.
   - Add architecture tests that fail if purchasing lifecycle functions reintroduce raw creator/requester/submitter self-approval exceptions instead of `governance_assert_not_self`.
   - Run the targeted SQL suite, governance architecture tests, and Supabase security linter.

7. **Verify the real owner workflow end to end**
   - With the signed-in owner session, approve the current submitted PR through the real application RPC and inspect `approved_by`, status, approval history, outbox, and SoD audit event.
   - Exercise an RFQ approval and the applicable PO/bill paths under the same tenant governance mode.
   - Confirm a caller cannot bypass permissions, lifecycle gates, or a real approval request merely because the tenant is in solo mode.

## Technical boundary

- No new governance engine, settings table, module-local threshold, or client-side role decision.
- `approval_route` / `approval_decide` remain the only approval workflow engine.
- `governance_assert_not_self` remains the only self-action policy resolver.
- Solo mode relaxes maker-checker for authorized owner/admin operators; it does not bypass authentication, business access, document-state validation, approval rules, accounting controls, or audit logging.
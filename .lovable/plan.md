# RFQ / Sourcing Domain — Verification Result & Remaining Work

Independent verification of the previous engineer's claims is complete. Findings
below are evidence-based (database introspection + code reads), not assumptions.

## Phase 1 — Verification of claimed work

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Phase 1 data model (invitations, quotations, awards, revisions) | Confirmed | All 8 `rfq*` tables exist; `rfq_quotation_items` carries UOM, base qty, alternate product, tax, lead time |
| Phase 2 lifecycle RPCs | Confirmed, plus one extra | 11 `rfq_*` functions live, including an undocumented `rfq_withdraw_quotation` |
| Phase 3 internal UI on RPCs only | Confirmed | No direct `rfqs` status writes anywhere in `src/` |
| Phase 5a legacy retirement | Confirmed | `rfq_vendors`, `rfq_vendor_items`, `sourcing_event*` absent from the database and from `src/` (only referenced as banned names in the guard test) |
| Conversion-completeness trigger | Confirmed | `trg_rfq_assert_conversion_complete` present on `rfqs` |
| Phase 4 portal quotation capture | Confirmed for capture only | Submission goes solely through `rfq_record_quotation` |

Nothing claimed as complete was found to be fake or superficial. Three claims,
however, are complete only in the narrow sense stated, and hide real domain gaps
(below).

## New findings — not in the previous plan

1. **Approval is bespoke, not the enterprise approval engine.**
   `rfqs.approval_request_id` exists but is written by nothing. `rfq_approve`
   enforces only "approver ≠ submitter" inline. Every other governed document
   (sales orders, payroll, app access) routes through `approvalEngine`
   (`routeApproval` / `decideApproval`) and `approval_requests`, which is where
   threshold, category, department and delegation rules live. RFQ therefore has
   a second, weaker approval path — exactly the duplication the parent prompt
   forbids.

2. **Invitation delivery is a dead queue.**
   `rfq_release` sets `rfq_invitations.delivery_state = 'queued'` and emits
   `rfq.supplier_invitation_requested`. Nothing consumes that event and nothing
   ever moves an invitation past `queued`. Suppliers are never actually
   contacted; the portal only works if the supplier happens to log in. There is
   also no `purchases.rfq` document kind, so RFQ cannot be emailed through the
   shared document/email pipeline the way POs and bills are.

3. **Expiry is client-driven.**
   `useRFQs.ts` calls `rfq_expire_due` opportunistically when a user loads the
   list. An RFQ nobody looks at never expires — deadline enforcement depends on
   someone opening a screen.

4. **Alternate-product offers are schema-only.** `is_alternate` /
   `alternate_product_id` are honoured by the RPC but no supplier-facing input
   exists, so the column is permanently null in practice.

5. **No supplier bid attachments.** Confirmed absent, as claimed.

## Remaining work, in execution order

### Phase 5b — Invitation delivery pipeline (highest priority)
The RFQ owns the *intent* to communicate; the existing communication subsystem
owns delivery. No new email infrastructure.
- Register a `purchases.rfq` document kind + template so an RFQ renders through
  the shared document renderer.
- Add a server function that drains `rfq.supplier_invitation_requested` from
  `business_event_outbox`, renders the RFQ document, sends via the existing
  document email path, and transitions `delivery_state`
  `queued → sending → sent → delivered | failed` with `delivery_error`.
- Retry with backoff; a provider failure must never roll back the RFQ state.
- Surface delivery state and resend per invitation in `rfqView.tsx`.

### Phase 5c — Deadline enforcement off the client
- Move `rfq_expire_due` to a scheduled sweep (pg_cron → public API route),
  business-scoped and idempotent.
- Remove the opportunistic client call; keep the derived "closing soon" badge.
- Optional reminder emails reuse the same delivery pipeline, driven by
  `reminder_count` / `last_reminder_at`.

### Phase 6 — Converge approval onto the canonical engine
- `rfq_submit_for_approval` creates an `approval_requests` row through the same
  routing rules as other documents and stores `approval_request_id`.
- `rfq_approve` becomes a decision recorded via the engine; the inline SoD check
  stays as a floor, not as the whole control.
- Award (`rfq_award`) gets the same treatment where an award threshold applies,
  so "create → approve own → award own → PO" is impossible.

### Phase 4b — Supplier bid attachments
- Reuse the existing document/storage system; no parallel upload path.
- Portal RLS scoped to the invited supplier only; attachments bound to a
  quotation version so they are immutable alongside the bid.

### Phase 4c — Structured alternate-product offers
- Supplier-facing product picker resolving through the canonical product service
  (no RFQ-local product logic), writing `is_alternate` /
  `alternate_product_id`, and flagged in the comparison matrix.

### Deferred, tracked, out of RFQ scope
Pre-existing branch/business scope violations outside procurement
(`useExpensesPaginated`, `AccountsPayable`, ~51 unscoped reads across 36 files).

## Technical notes

- Every lifecycle transition stays RPC-only and continues to emit through
  `_rfq_emit` into `business_event_outbox`.
- Delivery work is a consumer of the outbox, never inline in the transition RPC.
- New tables get `GRANT`s in the same migration; new RPCs are `SECURITY DEFINER`
  with `SET search_path = public` and lock their aggregate `FOR UPDATE`.
- Guards to run after each phase: `rfq-sourcing-domain.test.ts`,
  `procurement.test.ts`, `approval-engine-entrypoints.test.ts`,
  `purchases-branch-scope.test.ts`.

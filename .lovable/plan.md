# RFQ / Sourcing — Verification Verdict and Remaining Phases

Independent re-verification of the previous engineer's claims is complete. Every
statement below was confirmed directly against the database and the source tree.

## Phase 1 — What is genuinely done

| Claimed item | Verdict | Evidence |
| --- | --- | --- |
| Phase 5b invitation delivery pipeline | Done | `rfq_invitations_claim_for_delivery` + `rfq_invitation_record_delivery` exist; `outbox-dispatcher` registers a handler for `rfq.supplier_invitation_requested` and drives `queued → sent/failed`; `rfqView.tsx` shows delivery state and a per-invitation resend |
| Phase 5c deadline enforcement off the client | Done | pg_cron job `rfq-expire-due-hourly` runs `rfq_expire_due_all()`; `useRFQs.ts` no longer calls the expiry RPC opportunistically |
| Phase 4b supplier bid attachments | Done | `rfq_attach_quotation_document` / `rfq_remove_quotation_attachment` RPCs plus `BidAttachmentsPanel` shared between the internal record and the vendor portal |
| Phase 6 approval on submit/approve | Partially done | `rfq_submit_for_approval` routes through the canonical `approval_route` with an idempotency key and stores `approval_request_id`; `rfq_approve` decides through the engine |
| Phase 4c structured alternate-product offers | Not done | Columns exist on `rfq_quotation_items`, but no supplier-facing input and no reference anywhere in the vendor portal or award drawer |

## New finding — the award step is still ungoverned

`rfq_award` was read in full. It validates quantities, quotation ownership and
single-award-per-RFQ, but it performs **no approval routing and no
separation-of-duties check at all**. The person who submitted and approved an
RFQ can also award it, then convert it to a purchase order. The control the
parent prompt calls out — "create → approve own → award own → PO must be
impossible" — is therefore still open at the award boundary, even though the
submit/approve boundary is now correct.

## Remaining work, in execution order

### Phase 6b — Govern the award decision (highest priority)
- Add a segregation-of-duties floor inside `rfq_award`: the awarding user may
  not be the RFQ's approver, mirroring the existing approver ≠ submitter rule.
- Route the award through the canonical approval engine when policy gates it,
  using the awarded value (not the target-price estimate) as the amount, an
  idempotency key of `rfq.award:<rfq_id>:<version>`, and a new duty code so the
  award can be configured independently of the RFQ approval.
- Hold the RFQ in an "award pending approval" state until the engine decides;
  `rfq_convert_awards_to_po` must refuse to run while an award approval is
  outstanding.
- Surface the pending/approved award state in `rfqView.tsx` and the award
  drawer, using the same governance affordances other documents already use.

### Phase 4c — Structured alternate-product offers
- Add an alternate-product toggle and product picker to the supplier quotation
  form in the vendor portal, resolving products through the canonical product
  service (no RFQ-local product or barcode logic).
- Extend `rfq_record_quotation` validation so an alternate line must carry
  `alternate_product_id`, and a non-alternate line must not.
- Flag alternates distinctly in the internal comparison matrix and in the award
  drawer, so a buyer never awards a substitute without seeing it as one.
- Carry the alternate product (not the requested product) into
  `rfq_convert_awards_to_po`, keeping the requested line traceable.

### Verification after each phase
`rfq-sourcing-domain.test.ts`, `procurement.test.ts`,
`approval-engine-entrypoints.test.ts`, `purchases-branch-scope.test.ts`.

## Technical notes

- All lifecycle changes stay RPC-only, `SECURITY DEFINER`,
  `SET search_path = public`, locking their aggregate `FOR UPDATE`, and continue
  to emit through `_rfq_emit` into `business_event_outbox`.
- No second approval engine: award gating reuses `approval_route` /
  `approval_decide` exactly as submit/approve now does.
- No new tables are needed for either phase; the alternate-product columns and
  the `approval_request_id` linkage already exist.

## Out of scope (tracked, not opened here)

Pre-existing branch/business scope violations outside procurement
(`useExpensesPaginated`, `AccountsPayable`, and the remaining unscoped reads).

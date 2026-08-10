# RFQ / Sourcing Domain — Authoritative Project Status

Live status file. Update it after every implementation. Phases are executed in
the order below; do not jump ahead or sideways.

## Currently active

**Phase 4c — structured alternate-product offers.** Not started.

## Completed and verified

| Phase | Scope | State | Evidence |
| --- | --- | --- | --- |
| 1 | Data model: `rfqs`, `rfq_items`, `rfq_invitations`, `rfq_quotations`, `rfq_quotation_items`, `rfq_awards`, `rfq_award_items`, `rfq_revisions` | Done | All 8 tables live in the database |
| 2 | Lifecycle RPCs (`rfq_submit_for_approval`, `rfq_approve`, `rfq_release`, `rfq_record_quotation`, `rfq_withdraw_quotation`, `rfq_award`, `rfq_convert_awards_to_po`, `rfq_revise`, `rfq_cancel`, `rfq_expire_due`) | Done | Functions present; no client-side status writes |
| 3 | Internal UI runs on RPCs only | Done | `rfq-sourcing-domain.test.ts` guard passes |
| 4 | Portal quotation capture (versioned, immutable, supersede-on-revise) | Done | `rfq_record_quotation` is the sole entry point |
| 5a | Legacy retirement (`rfq_vendors`, `rfq_vendor_items`, `sourcing_event*`) | Done | Absent from DB and from `src/`; banned by guard |
| 5b | Invitation delivery pipeline | Done | `rfq_invitations_claim_for_delivery`, `rfq_invitation_record_delivery`, `rfq_invitation_resend`; `outbox-dispatcher` handler + `send-document-email` `rfq` document type; delivery state and resend surfaced in `rfqView.tsx` |
| 5c | Deadline enforcement off the client | Done | `rfq_expire_due_all` on hourly `pg_cron` (`rfq-expire-due-hourly`); opportunistic client call removed from `useRFQs.ts` |
| 6 | Approval on the canonical governance engine | Done | `rfq.approve` registered in `governance_action_registry`; `rfq_submit_for_approval` calls `approval_route`; `rfq_approve` refuses gated RFQs with `GOV_USE_APPROVAL_ENGINE`; `_mirror_approval_to_rfq` syncs decisions; ADR-0101 + `governance-single-engine.test.ts` guard |
| 4b | Supplier bid attachments | Done | See below |

### Phase 4b delivery detail (this pass)

- `rfq_quotation_attachments` table: bound to a quotation **version**,
  `UNIQUE (quotation_id, file_path)`, kind whitelist, `carried_forward_from`
  lineage, GRANTs issued, RLS = read-only for buying staff (business-scoped)
  and for the owning supplier (portal identity).
- Private bucket `rfq-bid-attachments`, key layout
  `{rfq_id}/{quotation_id}/{uuid}-{filename}`. `storage.objects` policies grant
  read to invited suppliers and to business staff, insert to both. **No update
  or delete policy** — bid evidence is write-once.
- `rfq_attach_quotation_document` and `rfq_remove_quotation_attachment`
  (SECURITY DEFINER, `search_path = public`, lock the quotation `FOR UPDATE`):
  only the live `submitted` version accepts changes, suppliers are blocked past
  the response deadline, and the path prefix is validated against the quotation.
- `rfq_record_quotation` now copies the superseded version's attachments into
  the new version, so the live bid always carries its evidence while history
  stays intact.
- Client: `src/features/purchases/rfqs/bidAttachments.ts` (single access path,
  signed URLs) and `BidAttachmentsPanel.tsx`, mounted read-only in the buyer
  record (`rfqView.tsx` → "Bid documents") and editable in the vendor portal
  (`VendorRFQDetail.tsx`).
- Guard: `rfq_quotation_attachments` added to the immutable-tables list and the
  two new RPCs to the canonical RPC list in `rfq-sourcing-domain.test.ts`.

## Pending

### Phase 4c — structured alternate-product offers (next)
`is_alternate` / `alternate_product_id` are honoured by `rfq_record_quotation`
but no supplier-facing input writes them, so they are permanently null.
- Supplier-facing product picker in `VendorRFQDetail.tsx` resolving through the
  canonical product service — no RFQ-local product lookup logic.
- Flag alternates distinctly in the buyer comparison matrix in `rfqView.tsx`
  (an alternate is not price-comparable with the requested item without an
  explicit buyer acceptance).
- Keep the RPC as the only writer; no schema change is expected.

### Phase 7 — award governance thresholds (after 4c)
`rfq_award` is not yet routed through the governance engine. Register
`rfq.award` in `governance_action_registry` and gate awards above the
configured threshold the same way `rfq.approve` is gated, so
"create → approve → award → PO" cannot be a single-person path.

### Deferred, tracked, explicitly out of RFQ scope
Pre-existing branch/business scope violations outside procurement —
`useExpenses`, `useExpensesPaginated`, `AccountsPayable` (4 offenders in
`purchases-branch-scope.test.ts`). These pre-date this workstream and must not
be silently folded into an RFQ phase; they need their own pass.

## Standing architectural rules (do not violate)

1. **One governance engine.** Approvals route through
   `src/lib/governance/approvalEngine.ts` + `approval_requests`. See ADR-0101.
   Creating a second approval engine, table, or client module fails
   `governance-single-engine.test.ts`.
2. Every lifecycle transition is an RPC and emits through `_rfq_emit` into
   `business_event_outbox`. Delivery/notification work is an outbox consumer,
   never inline in the transition.
3. New public tables get `GRANT`s in the same migration; new RPCs are
   `SECURITY DEFINER` with `SET search_path = public` and lock their aggregate
   `FOR UPDATE`.
4. RFQ never writes stock, cost layers, or the ledger.
5. Supplier-submitted evidence is immutable per bid version.

## Instructions for the next agent

1. **Verify before building.** Confirm Phase 4b independently:
   - `rfq_quotation_attachments` exists with GRANTs, RLS enabled and both read
     policies; no insert/update/delete policy on the table itself.
   - `storage.objects` has read + insert policies for `rfq-bid-attachments` and
     no update/delete policy.
   - `rfq_attach_quotation_document` rejects a superseded quotation, a past
     deadline for a portal user, and a path outside `{rfq_id}/{quotation_id}/`.
   - Submitting a revised quote carries attachments forward and leaves the
     superseded version's rows in place.
   - Guards: `rfq-sourcing-domain.test.ts`, `procurement.test.ts`,
     `governance-single-engine.test.ts` all green.
     `purchases-branch-scope.test.ts` fails only on the four deferred
     non-procurement offenders listed above — anything else is a regression.
2. **Then resume at Phase 4c**, followed by Phase 7. Do not start unrelated
   work, and do not leave a phase partially wired: schema, RPC, guard, buyer UI
   and supplier UI ship together.
3. Update this file at the end of each phase.

# RFQ / Sourcing Domain — Authoritative Project Status

Domain: Procurement sourcing (demand -> RFQ -> quotation -> award -> PO).
Original audit and roadmap: `.lovable/plan/rfq-sourcing-domain-architecture-audit-and-rebuild-plan-2026-08-10.md`.
This file is the live status. Update it after every implementation step.

## Current state

Phases 1, 2, 3 and 5a are complete and verified. The RFQ subsystem now runs on a
single server-authoritative lifecycle with immutable, versioned supplier bids and
full reverse traceability into purchase orders. The legacy sourcing engine has been
deleted outright — no fallbacks, no dual paths.

## Phase 1 — Data model (COMPLETE, verified)

- `rfqs` extended: `currency`, `required_by_date`, `deliver_to_warehouse_id`,
  `project_id`, `requisition_id`, `version`, `expires_at`.
- `rfq_items` extended: UOM, target price, sort order, requisition line link.
- New tables: `rfq_invitations`, `rfq_quotations`, `rfq_quotation_items`,
  `rfq_awards`, `rfq_award_items`, `rfq_revisions`.
- RLS for internal staff (business scoped) and vendor portal users (own supplier only).
- `purchase_orders` carries `rfq_id` / award linkage for reverse traceability.

## Phase 2 — Server-side lifecycle (COMPLETE, verified)

RPCs, each transactional, each emitting to `business_event_outbox` via `_rfq_emit`:
`rfq_submit_for_approval`, `rfq_approve`, `rfq_release`, `rfq_record_quotation`,
`rfq_award` (split awards per line), `rfq_convert_awards_to_po` (one PO per awarded
supplier), `rfq_revise`, `rfq_cancel`, `rfq_expire_due`.

Guarantees enforced in the database, not the client:
- Quotations are append-only and versioned; re-submission supersedes, never overwrites.
- Late bids blocked for portal submitters; internal users may accept late with a flag.
- Invitations bound to an RFQ version — a revision invalidates stale invitations.
- Status transitions are RPC-only; the client cannot write `rfqs.status`.

## Phase 3 — Internal UI (COMPLETE, verified)

- `src/hooks/useRFQs.ts` is the single domain client; every transition is an RPC call.
- `rfqView.tsx` shows the sourcing graph: invitations, quotation comparison matrix,
  awarded vs estimated value.
- `RFQAwardDrawer.tsx` supports split awards per line with justification.
- `src/pages/RFQs.tsx` pipeline: Draft -> Approved -> Sourcing -> Awarded -> Converted.
- `PurchasesDashboard.tsx` metrics aligned with the expanded lifecycle.

## Phase 4 — Vendor portal (COMPLETE for quotation capture)

- `useVendorPortal.ts` reads invitations plus the latest live quotation version.
- `VendorRFQDetail.tsx` submits through `rfq_record_quotation` only: header terms
  (lead time, incoterms, payment terms, validity, freight, notes) and per-line
  supplier item code, unit price, offered quantity, discount %, tax %, delivery date
  and line note. Deadline and stale-version submissions are blocked in the UI and
  again in the RPC.
- Submitted versions are shown as an immutable trail; re-submitting creates v(n+1).

Explicitly NOT in scope of the current build (tracked, not started):
- Supplier bid attachments through the shared document system (Phase 4b below).
- Structured alternate-product offers (`is_alternate` / `alternate_product_id` exist
  in the schema and are honoured by the RPC, but no supplier-facing product picker
  is exposed; suppliers express substitutes as a line note today).

## Phase 5a — Legacy retirement (COMPLETE, verified)

- Dropped `rfq_vendors`, `rfq_vendor_items`, the whole `sourcing_events` engine
  (4 tables, 5 RPCs, numbering helpers) and `rfqs.sourcing_event_id`. Deleted, not deprecated.
- Trigger `trg_rfq_assert_conversion_complete`: an RFQ can only reach `converted`
  when every award is linked to a real purchase order.
- Architecture guards in `src/test/architecture/rfq-sourcing-domain.test.ts` (9/9 pass):
  no client-side status writes, no legacy table references, lifecycle must go through RPCs.
- `procurement.test.ts` cleaned of deleted RPC names — passes.
- `purchases-branch-id-stamping.test.ts` and `purchases-branch-scope.test.ts` regexes
  corrected (a guarded-table read no longer binds to an unrelated later insert; write
  RETURNING clauses and primary-key reads are no longer treated as unscoped reads).
  No RFQ file appears as an offender in either guard.

## Pending work

| Item | Phase | State |
| --- | --- | --- |
| Supplier bid attachments (storage bucket + portal RLS + document links) | 4b | Not started |
| Structured alternate-product offers in the portal | 4c | Not started |
| Invitation delivery/email pipeline wired to `rfq_invitations.delivery_state` | 5b | Not started |
| Pre-existing branch/business scope violations outside procurement (`useExpensesPaginated`, `AccountsPayable`, ~51 unscoped reads across 36 files) | separate workstream | Failing guards, out of RFQ scope |

## Active phase

Phase 5a is closed. Phase 4b (supplier bid attachments) is the next milestone.

## Instructions for the next agent

1. Verify before extending. Confirm, do not assume:
   - `rfq_vendors`, `rfq_vendor_items` and all `sourcing_event*` objects are absent
     from the database and from `src/` (ripgrep must return nothing).
   - Every RFQ status change in `src/` goes through an `rfq_*` RPC; no `.update({ status`
     against `rfqs` anywhere.
   - `src/test/architecture/rfq-sourcing-domain.test.ts`, `procurement.test.ts`,
     `purchases-branch-id-stamping.test.ts` and `purchases-branch-scope.test.ts` are the
     guards to run first; only the last two still list non-procurement offenders.
   - Exercise the portal flow end to end: release an RFQ, submit a bid, revise it, and
     confirm v1 becomes `superseded` with `superseded_by` set and totals recomputed server-side.
2. Then resume at Phase 4b — supplier bid attachments — before anything else.
   Reuse the existing document/storage system; do not invent a parallel upload path.
3. Do not retire something and leave a fallback. Delete it, and update this file in the
   same step so it stays the authoritative status.

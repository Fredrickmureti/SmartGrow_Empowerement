# RFQ / Sourcing Domain — Architecture Audit and Rebuild Plan

## What an RFQ is (and is not)

An RFQ is a **sourcing event**: a formal, time-boxed invitation to a set of qualified suppliers to price a defined demand, so procurement can compare competing offers and justify a supplier selection.

It is not an order, not a commitment, not a liability, not an inventory or accounting event. It creates no stock, no GL posting, no payable. Its only durable outputs are: supplier offers, an award decision with justification, and one or more Purchase Orders.

Canonical shape in mature ERPs (SAP/Ariba, Oracle, D365, Coupa, Odoo):

```text
Demand (requisition / reorder / project / manual)
   -> RFQ (header + lines + invited suppliers, versioned)
   -> Invitation (per supplier, with send + delivery state)
   -> Quotation (per supplier, immutable once submitted, versioned)
   -> Evaluation (comparable on price, lead time, terms, normalised UOM+currency)
   -> Award (full / partial / split, approved, justified)
   -> Purchase Order(s) (one per awarded supplier)
   -> GRN -> Bill -> Payment -> Bank
```

## Current implementation — evidence

Verified by reading `src/hooks/useRFQs.ts`, `src/features/purchases/rfqs/*`, `src/pages/RFQs.tsx`, `src/pages/vendor-portal/VendorRFQDetail.tsx`, and the live database (tables, RPC bodies, row counts — all RFQ/sourcing/requisition tables are currently empty).

**Two competing sourcing engines exist.**
- `rfqs` / `rfq_items` / `rfq_vendors` / `rfq_vendor_items` — the UI path.
- `sourcing_events` / `sourcing_scoring_criteria` / `sourcing_vendor_scores` / `sourcing_event_awards`, with RPCs `create_sourcing_event`, `open_sourcing_event`, `close_sourcing_event`, `score_sourcing_vendor`, `award_sourcing_event_atomic`, plus outbox emission — richer (sealed bid, criteria weights, split awards, requisition link) but **has no bid/quotation table at all** and no UI. `rfqs.sourcing_event_id` exists and is never populated.

**Verdict per subsystem**

| Area | Verdict | Evidence |
| --- | --- | --- |
| Supplier quotation as a first-class record | Missing | Only `rfq_vendors` (one `quoted_total`, `lead_time_days`, `notes`) + `rfq_vendor_items` (`unit_price`, `available_qty`). No currency, tax, UOM, validity, incoterms, payment terms, alternates, attachments, no version, mutable forever |
| Award | Wrong | `award_rfq_atomic` declines every other supplier and sets the RFQ to `closed`. Split/partial award impossible; no justification, no approval, no award record |
| Award -> PO | Broken | `convert_rfq_to_po_atomic` raises "already closed" on any awarded RFQ, so the documented award-then-convert path cannot execute |
| PO traceability | Wrong | `purchase_orders` has `requisition_id`/`contract_id` but **no `rfq_id` / `rfq_vendor_id`**. After conversion, no query answers "which RFQ produced this PO" — reverse traceability from Bill/GRN/Payment dies at the PO |
| Conversion fidelity | Wrong | Copies base-currency of the business (not supplier currency), zero tax, no UOM/packaging (`display_uom_id`, `packaging_id` left null), no `deliver_to_warehouse_id`, no `project_id`, no `requisition_id`, `expected_date` = the RFQ response deadline. Falls back to `target_price` when the supplier never quoted |
| Upstream demand | Missing | `purchase_requisitions` exist with `suggested_supplier_id`; nothing links a requisition (or item) to an RFQ. RFQs are manual-only; "why was this RFQ created" is unanswerable |
| Invitation / communication | Missing | No invitation record, no `sent_at`, no delivery/bounce state, no reminders. "Mark sent" is a client-side status write |
| Lifecycle | Wrong | States are `draft/sent/received/closed/cancelled`, all written by the browser via raw table UPDATE. No approval, no release, no evaluation, no awarded, no expired, no reopened. `closed` conflates awarded, converted and abandoned |
| Revisions | Missing | Editing replaces items *and deletes all `rfq_vendors` rows* — silently destroying supplier responses. No version history, no re-notify, no obsolete-version protection |
| Deadline | Not enforced | `deadline` is a date with no expiry mechanism and no server-side gate on late responses |
| UOM | Missing | `rfq_items.quantity` is `integer` with no `uom_id`; the multi-UOM/packaging architecture is bypassed end to end |
| Currency / tax | Missing | No currency on RFQ, line, or quote; conversion hardcodes tax 0 |
| Approval / SoD | Missing | No approval on RFQ or award; one user can create, award and convert |
| Vendor portal | Weak | `VendorRFQDetail` writes `rfq_vendors` directly, repeatedly, with no immutability, no deadline check, no versioning |
| Landing metrics | Misleading | Computed client-side over the full unpaginated list; "Conversion" = `closed / total`, and `closed` is also set by awarding without conversion |
| Finance / Inventory / Warehouse boundary | Correct | RFQ writes no stock, cost layers, or journal entries; the `procurement.test.ts` guard protects this. Keep it |
| Barcode scan-to-line | Correct | Uses the shared `DocumentLineScanner`; product identity stays canonical |

**Root cause:** the RFQ tables model a *supplier shortlist with a price memo*, not a sourcing event with competing offers. Everything downstream (comparison, award, PO, audit) inherits that.

## Direction

Converge on **one** engine: keep the `rfqs` tables as the user-facing sourcing document (it owns the UI, routes, number series, vendor portal) and absorb the missing capability, retiring the unused `sourcing_events` engine's overlap by folding its ideas (criteria, scores, split awards) onto the RFQ tables. All tables are empty, so no data migration is required.

## Implementation phases

**Phase 1 — Domain model (migration).** Add to `rfqs`: `currency`, `required_by_date`, `deliver_to_warehouse_id`, `deliver_to_branch_id`, `project_id`, `requisition_id`, `version`, `released_at/by`, `awarded_at/by`, `closed_at/by`, `expires_at`, `award_justification`, and a real status enum (`draft, pending_approval, approved, sent, responses_received, under_evaluation, awarded, partially_awarded, converted, closed, cancelled, expired`). Add `uom_id`, numeric `quantity`, `requisition_item_id`, `need_by_date` to `rfq_items`. New tables: `rfq_invitations` (per supplier: sent_at, channel, delivery state, deadline, reminder count), `rfq_quotations` (immutable per version: supplier, currency, validity, incoterms, payment terms, lead time, submitted_at, superseded_by), `rfq_quotation_items` (quoted qty + UOM, unit price, tax, alternate product, notes), `rfq_awards` (per supplier per line: awarded qty, price, resulting `purchase_order_id`), `rfq_revisions` (versioned snapshot + reason). Add `rfq_id` and `rfq_award_id` to `purchase_orders`, `rfq_quotation_item_id` to `purchase_order_items`. Full GRANTs + org/business-scoped RLS on every new table; vendor-portal policies scoped to the invited supplier's contact only.

**Phase 2 — Server-side lifecycle RPCs.** `submit_rfq_for_approval`, `approve_rfq` (reusing the existing `approval_requests` infrastructure, not a new engine), `release_rfq` (emits `SupplierInvitationRequested` to `business_event_outbox` — never sends mail inline), `record_supplier_quotation` (deadline gate, immutability, supersede-on-revise), `revise_rfq` (bumps version, invalidates open quotations, re-notifies), `award_rfq_atomic` v2 (accepts a split-award payload, validates awarded qty against quoted qty, writes `rfq_awards`, requires justification, idempotent under retry), `convert_rfq_to_po_atomic` v2 (one PO per awarded supplier, copies quoted price/currency/tax/UOM/lead time, stamps `rfq_id`/`rfq_award_id`/`requisition_id`/warehouse/project, guards against duplicate conversion), `expire_rfq` (derived-then-persisted at read/transition time — no cron). Every transition emits an outbox event and an audit row.

**Phase 3 — Frontend rewrite.** Create/edit forms carry currency, UOM, warehouse, need-by date, and a requisition picker; target price relabelled as an internal, never supplier-visible budget reference. Record page gains a **quotation comparison matrix** (normalised to base currency and stocking UOM) and a split-award panel. All status changes go through the RPCs — no raw table writes, no client-side authorization. Landing metrics move to a server-side aggregate view (`open`, `awaiting responses`, `awarded`, `converted`, award-to-PO conversion rate) with pagination.

**Phase 4 — Vendor portal.** Quotation submission becomes an RPC writing an immutable `rfq_quotations` version, with deadline enforcement, per-line quoted UOM/currency, partial quantities, alternates and attachments through the shared document system.

**Phase 5 — Guards.** Extend `src/test/architecture/procurement.test.ts` with: RFQ never writes stock/GL; no client-side RFQ status writes; PO created from an award always carries `rfq_id`; conversion is idempotent.

## Notes

Communication, approval, product/UOM, currency, tax, document storage and accounting all stay owned by their existing subsystems — RFQ only expresses intent and consumes their state.

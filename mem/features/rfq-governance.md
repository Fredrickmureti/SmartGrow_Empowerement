---
name: RFQ governance & sourcing invariants
description: RFQ lifecycle is RPC-only; submit/approve/award all route through the canonical approval engine; alternate-product offers are server-validated
type: feature
---

# RFQ / Sourcing invariants

- Every RFQ transition is a `SECURITY DEFINER` RPC (`rfq_submit_for_approval`,
  `rfq_approve`, `rfq_release`, `rfq_award`, `rfq_convert_awards_to_po`, …).
  The client never writes `rfqs.status`, awards, or quotation rows directly.
- Approval is the ONE canonical engine (`approval_route` / `approval_decide`).
  RFQ has two independent gates:
  - `rfqs.approval_request_id` — the RFQ document (`rfq.submit` / `rfq.approve`)
  - `rfqs.award_approval_request_id` — the award decision (`rfq.award`)
  Never add a module-local threshold or a second approval path.
- SoD on award: the user who submitted or approved the RFQ cannot award it.
- `_rfq_assert_award_decided` blocks `rfq_convert_awards_to_po` while the award
  approval is pending; award rejection rolls the award back and returns
  quotations to `submitted` via `_mirror_approval_to_rfq`.
- Alternate-product offers: suppliers set `is_alternate` /
  `alternate_product_id` on `rfq_quotation_items`. The portal resolves the
  catalogue through `rfq_portal_search_products` (invitation-scoped; suppliers
  have no RLS read on `products`), and
  `_rfq_quotation_item_validate_alternate` re-checks org/business/active and
  "must differ from requested" on write. PO conversion uses
  `COALESCE(alternate_product_id, product_id)`.
- Invitation delivery is outbox-driven (`outbox-dispatcher`), expiry is
  pg_cron-driven — never client-triggered.

---
name: Document numbering
description: Year-segmented document numbers parse only the trailing counter and generate under a per-org advisory lock
type: feature
---
Numbers shaped `PREFIX-YYYY-NNNN` must derive the next counter from the
**trailing segment only** — `split_part(number, '-', 3)` or a `[0-9]+$`
capture. Stripping every non-digit from the whole string folds the year into
the counter (`PO-2026-0003` → `PO-2026-20260004`). This defect shipped in
`get_next_po_number` and was fixed 2026-08-16; the sales-side generators
carry a warning comment about it.

Every generator that computes a counter must take
`pg_advisory_xact_lock` scoped to the org (plus branch/business where the
uniqueness constraint is narrower). Delegating overloads are fine and are
exempt.

`public.get_next_document_number(org, business, prefix, table, column, …)` is
the shared authority (added 2026-08-17): advisory-locked per prefix+org+business,
trailing-counter parse, retries on collision. Warehouse issuers
(`get_next_wave_number`, `get_next_asn_number`, `get_next_manifest_number`,
`get_next_carton_number`, `get_next_recall_reference`,
`get_next_opening_stock_number`) delegate to it; new document types should too.

Clock strings (`CC-260817-013059278`) and md5/uuid fragments are never
acceptable as operator-facing identifiers — that was the WMS defect fixed on
2026-08-17. Machine-only barcodes (LPN payloads) may still be opaque.

Ratchets: `supabase/tests/document_numbering_segment_parse_test.sql` and
`supabase/tests/document_numbering_no_clock_test.sql`.

Document numbers of posted/received documents are immutable —
`_po_commercial_fields_immutable()` and friends will refuse a rewrite. Repair
forward, never rewrite history.
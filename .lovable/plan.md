# Warehouse document numbering — verdict and remediation

## Verdict: our system is wrong, and it is an inconsistency, not a style choice

`CC-260817-013059278` is not a document number. It is a wall-clock timestamp
(`CC-YYMMDD-HH24MISSMS`) rendered as text. Nothing in it is sequential, nothing
tells an operator "this is the fifth count we have done this year", and two
counts started in the same millisecond would collide rather than queue.

Every commercial and HR document in this system already does the right thing.
There are 33 dedicated generators in the database — `get_next_invoice_number`,
`get_next_grn_number`, `get_next_po_number`, `get_next_journal_entry_number`,
`get_next_payroll_number` and so on — all producing `PREFIX-YYYY-NNNN` under a
per-organisation advisory lock. A new business genuinely sees `INV-2026-0001`.

Warehouse operations never got that treatment. A scan of live functions shows
these still minting identifiers from the clock, a UUID slice, or an md5 hash:

| Function | Shape it produces |
|---|---|
| `create_pick_wave`, `wms_plan_waves`, `wms_enqueue_order_for_wave` | `WAVE-260817-A3F9C` |
| `open_loading_manifest` | `LM-260817-013059` |
| `open_pack_carton` | `SHIP-260817013059-4b2c1e` |
| `create_inbound_shipment` | `ASN-20260817-551d3439` |
| `receive_goods_to_wms`, `wms_split_putaway_task` | `LPN-26A3F9C1` |
| `recall_lot` | `RCL-20260817-013059-8f21ab` |
| `record_opening_stock` | `OPEN-20260817-013059` |
| `wms_create_return_finance_doc` | `SR-202608-4b2c1e` |
| `convert_lead_to_estimate` / `convert_lead_to_project` | `EST-<unix epoch>` / `PROJ-<unix epoch>` |
| `request_employee_loan` | `LR-20260817013059` |

Cycle count has already been fixed (`get_next_count_session_number`, applied
2026-08-17) — new sessions get `CC-2026-0001`. The four existing sessions keep
their historical codes, because posted document numbers are never rewritten.
So the warehouse is currently half-converted, which is the worst state to
leave it in.

## How large systems handle this

SAP (EWM and ECC) issues every document from a **number range object** per
document type and year, sequential, gap-tolerant, buffered per app server.
Oracle Fusion WMS and Manhattan Associates do the same via document sequences.
Blue Yonder assigns wave IDs from a sequence, not a timestamp. NetSuite lets an
admin set prefix, start number and minimum digits per transaction type. The
common rules across all of them:

1. Human-facing documents are **sequential per entity and period**, dense from 1.
2. The prefix names the document type; the year gives period context.
3. The number is issued by a **single serialising authority**, not the caller.
4. Numbers are **immutable** once issued.
5. Machine identifiers (licence plates, SSCC, container tags) are the one
   legitimate exception — they may be opaque, but even those are serials from a
   range (GS1 SSCC = extension digit + GS1 prefix + serial reference), never a
   truncated md5 that can silently collide.

Measured against that, our commercial side is compliant and our warehouse side
is not.

## Why it actually matters (beyond looking odd)

- **Collision risk is real.** A 5-char md5 slice on wave codes is ~1M distinct
  values with birthday collisions from a few hundred waves; the truncated-UUID
  ASN codes are the same class of defect. There is no retry loop behind them.
- **Not auditable.** An auditor cannot tell whether counts 3 and 4 are missing.
  Sequence density is the point of a document number.
- **Unsearchable in operations.** Nobody radios "run count CC dash two six zero
  eight one seven dash zero one three zero five nine two seven eight".
- **Inconsistent paperwork.** The same warehouse operator sees `GRN-2026-0004`
  on a receipt and `WAVE-260817-A3F9C` on the wave that consumes it.

## Remediation

### Phase 1 — a shared numbering authority
Add `public.get_next_document_number(_org, _business, _prefix, _table, _column)`
implementing once what the 33 generators each re-implement: per-org (plus
business where uniqueness is narrower) `pg_advisory_xact_lock`, trailing-segment
parse only (`split_part(number,'-',3)` — never strip-all-digits, that is the
`PO-2026-20260004` defect already recorded in project memory), `PREFIX-YYYY-NNNN`
output, collision retry. Existing generators stay as thin delegates so no caller
changes and no number ever moves.

### Phase 2 — convert operator-facing warehouse documents
In this order, each with its own migration and a uniqueness index:

- `WAVE-YYYY-NNNN` — `create_pick_wave`, `wms_plan_waves`, `wms_enqueue_order_for_wave`
- `ASN-YYYY-NNNN` — `create_inbound_shipment`
- `LM-YYYY-NNNN` — `open_loading_manifest`
- `SHIP-YYYY-NNNN` — `open_pack_carton`
- `RCL-YYYY-NNNN` — `recall_lot`
- `OPEN-YYYY-NNNN` — `record_opening_stock`
- `SR-YYYY-NNNN` — `wms_create_return_finance_doc`

Historical rows keep their codes. Only newly issued numbers change shape, so
nothing in printing, scanning or lookup breaks; the columns stay `text`.

### Phase 3 — licence plates, handled honestly
`LPN-…` stays opaque by design, but moves off md5 onto a genuine serial
(`LPN-<org serial>` with a check digit) so it cannot collide and can be
range-audited. This is documented as a deliberate exception, not an oversight.

### Phase 4 — non-warehouse stragglers
`convert_lead_to_estimate` and `convert_lead_to_project` should call the
existing `get_next_estimate_number` / `get_next_project_number` rather than an
epoch string. `request_employee_loan` should call `get_next_loan_number`.
These are one-line fixes to callers that ignored generators we already own.

### Phase 5 — make the rule enforceable
Extend `supabase/tests/document_numbering_segment_parse_test.sql` (and the
`_no_uuid_test` ratchet) to fail when **any** function builds a user-facing
identifier from `clock_timestamp`, `now()`, `md5`, `gen_random_uuid` or an epoch,
with an explicit allow-list for licence plates. Add an ADR recording that
warehouse documents follow the same numbering contract as commercial ones.

## Scope check before we build

Phase 1 + Phase 2 is the substance of the answer to "is our system wrong".
Phases 3–5 can follow, but shipping Phase 2 without Phase 5 means the next
warehouse feature reintroduces the defect.

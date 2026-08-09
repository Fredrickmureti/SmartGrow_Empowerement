---
name: Credit note provenance and ceiling
description: Invoice-line provenance, server-resolved money, credit ceiling, idempotency and draft-only editing for sales credit notes
type: feature
---
A sales credit note line may carry `credit_note_items.invoice_item_id`. When it does,
the server — not the browser — is the authority:

- Money is recomputed in `_resolve_credit_note_line` from the *invoice* line:
  net unit price = `unit_price * (1 - discount_percent/100)`, tax prorated from the
  invoice line's own `tax_amount` (falling back to `tax_rate`). Client-supplied
  price/description/tax on an invoice-referenced line are ignored.
- Historical fidelity is stored: `source_unit_price`, `source_discount_percent`,
  `source_tax_rate`, plus packaging/UoM/eTIMS snapshots.
- Credit ceiling: total non-void credited quantity per invoice line may never exceed
  invoiced quantity. `v_invoice_creditable_qty` is the read model (invoiced_qty,
  credited_qty, remaining_qty, remaining_net_amount); the ceiling is re-enforced
  inside the writer, and in edit mode the current credit note is excluded.
- A line whose `invoice_item_id` belongs to another invoice is rejected (42501).
- Off-invoice credits are allowed (`invoice_item_id` null) but still recomputed
  server-side; negative prices rejected.

Writers: `create_credit_note_atomic(_payload jsonb)` and
`update_credit_note_atomic(_payload jsonb)` only — the client never inserts/updates
`credit_notes` or `credit_note_items`. Editing is draft-only.

Idempotency: `credit_notes.client_request_id` with unique index
`(business_id, client_request_id)`; the create form holds one deterministic
`requestIdRef` per attempt, so retries/double-clicks cannot duplicate economics.

Guard: `src/test/architecture/credit-note-provenance.test.ts`.
Any migration touching a public function must end with `NOTIFY pgrst, 'reload schema'`.

# ADR 0020 — Which documents own a commercial payment term, and where T&C prose comes from

Status: accepted (2026-08-09)
Supersedes: nothing. Extends the payment-term workstream (`mem/features/payment-terms.md`).

## Context

`payment_term_id` currently exists on `contacts`, `invoices`, `bills` and
`sales_orders`. Purchase orders, expenses, estimates, credit notes and
delivery notes have none. Before adding the column anywhere else we need a
rule, otherwise "add it everywhere" quietly creates several sources of truth
for one credit period.

Two separate questions were open:

1. Does a purchase order carry a commercial term of its own, or does it only
   pass one along to the bill?
2. `bills`, `sales_orders` and `delivery_notes` have no prose `terms` column.
   Where does printed Terms & Conditions wording come from for them?

## Decision

### 1. A payment term belongs to a document that creates a payable or receivable

A term earns a column only when the document itself produces an obligation
with a due date:

| Document | Term column | Reason |
|---|---|---|
| Invoice | yes (exists) | Creates AR with a due date |
| Bill | yes (exists) | Creates AP with a due date |
| Sales order | yes (exists) | Commercial commitment; the invoice inherits it |
| Purchase order | **no** | A PO commits quantity and price, not a credit period. The term is resolved at bill time from the supplier |
| Expense | **no** | Settled at capture; there is no credit period to resolve |
| Estimate / quotation | **no** | Not yet an obligation. Wording about payment belongs in the T&C prose |
| Credit note | **no** | Reverses an existing obligation; it inherits the original document's timing |
| Delivery note | **no** | A logistics document (see ADR 0011) |

Consequence: purchase-side inheritance is `supplier default -> bill`, not
`supplier -> PO -> bill`. The existing `_fill_document_payment_term` trigger
on `bills` already implements exactly that, so no schema change is required.

If a business later genuinely negotiates a term at PO time, that is a new
decision and a new ADR — not a column added on the way past.

### 2. Terms & Conditions prose is template-owned, never term-derived

Prose lives in the document template / company default and is rendered at
print time. A payment-term *name* is never written into a prose field, and a
document without a `terms` column does not grow one just to hold wording.

For `bills`, `sales_orders` and `delivery_notes` the printed T&C block, when
required, comes from the document template. The structured term travels
separately in the snapshot's `payment_term` field
(`src/services/documents/snapshots/paymentTerm.ts`), which is what the PDF's
"Payment Terms" meta row and the thermal `Terms:` line read.

## Consequences

- No new `payment_term_id` columns are added by this ADR.
- A reviewer can reject "just add the column to purchase_orders" by pointing here.
- Anyone adding a printed T&C block to a bill, sales order or delivery note
  wires it to the template, not to the payment term.

# Commercial Terms, Payment Terms & Document Notes — Domain Audit & Convergence Plan

Audit only. No code changed. Every current-state claim below is backed by a source read or a live database query.

---

## A. What exists today (verified)

### The trigger, explained exactly

`"Payment due within 30 days."` is a **hardcoded React string literal**, not a setting:

- `src/features/sales/invoices/InvoiceCreatePage.tsx:118` — initial form state `terms: "Payment due within 30 days."`
- `:172` — same literal repeated in the form-reset path
- `:116` and `:170` — `due_date: format(addDays(new Date(), 30), "yyyy-MM-dd")`, also hardcoded

There is no company default, no DB column default, and no RPC behind either value. Company Settings → Terms does not participate in invoice creation at all unless a **customer** has been individually assigned a term.

### The payment-terms model that does exist

Live table `public.payment_terms`: `id, organization_id, business_id (NOT NULL), name, days int NOT NULL default 0, description, is_default, is_active`. Scope is **organization + business** (no branch scope).

Live data — exactly one row in the whole database:

```text
name "Net  20" | days 20 | description "payment is due within 20 days of invoice date" | is_default = FALSE
```

Two independent reasons your Net 20 never appears on an invoice:

1. Invoice create only consults `contacts.payment_term_id` (`InvoiceCreatePage.tsx:270-277`). No contact is assigned this term, so the hardcoded 30-day text stands.
2. Even the *bill* path, which does look for an org default (`src/hooks/useBills.ts:685-696`), finds none, because the only configured term has `is_default = false`, and falls through to a hardcoded "+30 days".

So this is not "the UI ignores the setting". It is **there is no company-level resolution step anywhere**, and the one place that tries to use a default is defeated by an unset flag.

### Where `payment_term_id` is actually stored

| Table | payment_term_id | terms text | notes |
|---|---|---|---|
| invoices | yes | yes | yes |
| sales_orders | yes | no (snapshot forces null) | yes |
| estimates | no | yes | yes |
| proforma_invoices | no | yes | yes |
| recurring_invoices | no | yes | — |
| contacts | yes (+ legacy `default_payment_terms` integer) | — | `notes`, `vendor_notes` |
| suppliers | `default_payment_term_id`, `default_incoterms` | — | — |
| businesses | `default_payment_terms` **integer** | — | — |
| **bills** | **NO COLUMN** | **NO COLUMN** | yes |
| purchase_orders, credit_notes, delivery_notes | no | no | yes |

`bills` having no `payment_term_id` is confirmed live (`bills?select=terms` → Postgres `42703 column does not exist`).

### Due-date computation

Entirely client-side. No DB trigger, no default and no RPC computes a document due date anywhere in the sales or purchase domain. (The only `%due_date%` DB functions — `compute_remittance_due_date`, `snapshot_remittance_due_date` — belong to payroll statutory filing and are unrelated.)

Conversion RPCs (`convert_estimate_to_invoice_atomic`, `convert_proforma_to_invoice_atomic`, `create_invoice_from_delivery_atomic`, `create_pos_credit_sale_invoice_atomic`) insert `due_date` as passed/copied and **do not carry `payment_term_id`** — only `convert_so_to_invoice_atomic` propagates it. `generate_recurring_invoice_occurrence` uses a third rule: `period_start + COALESCE(days_before_due, 30)`.

### Downstream truth: the due date is real accounting data

`finance_ar_open_items` / `finance_ap_open_items` expose `due_date` alongside `document_date`; aging buckets and overdue status are driven off it, and `update_overdue_invoices()` flips invoice status to `overdue` on `due_date < CURRENT_DATE`. A wrong due date is therefore **not cosmetic** — it moves receivables between aging buckets, changes overdue status, and drives dunning scans (`sms_scan_overdue_invoices`).

### Documents / PDFs

Snapshot builders read only the document's own free-text `terms` column: `salesInvoice.ts:166`, `salesEstimate.ts`, `salesProforma.ts`. **Every other builder hardcodes `terms: null`** — bill, PO, GRN, sales order, credit note, delivery note, returns, statements. No builder joins `payment_terms` or emits `payment_term_id`, so the rendering layer has no structured notion of a payment term at all.

---

## B. What is correct and must NOT be disturbed

- `payment_terms` as a structured master entity (`name` + `days`) scoped org+business. Do **not** create a second table.
- `invoices.payment_term_id`, `sales_orders.payment_term_id`, `contacts.payment_term_id`, `suppliers.default_payment_term_id` — the correct shape already exists.
- Storing `due_date` on the document is right: the document owns its settled truth, so master-data edits cannot rewrite history. Keep it.
- AR/AP projections, payment allocation, credit-note netting, journal posting, tax and snapshot freezing — untouched by this work.
- Keeping document `notes` distinct from `terms` is directionally right; it just needs meaning assigned.

---

## C. What is genuinely broken (ranked)

**P0 — business-truth violations**

1. Bills discard the selected payment term. `BillCreatePage` renders a term picker (`:326`) but `bills` has no `payment_term_id` column, so the choice is unrecoverable: AP aging has a due date with no auditable basis.
2. No company-level default resolution. Invoice create never falls back to the business default term, and the bill fallback is defeated because `is_default` is unset — the configured term is unreachable for any customer without an explicit assignment.
3. Conversion RPCs drop `payment_term_id` (estimate→invoice, proforma→invoice, delivery→invoice, POS credit sale). A converted invoice's due date has no traceable term.
4. Three competing due-date rules coexist: client `+30`, `bill_date + defaultTerm.days`, and recurring's `period_start + days_before_due ?? 30`.

**P1 — duplicated / competing sources of truth**

5. `businesses.default_payment_terms` and `contacts.default_payment_terms` (integer days) are legacy duplicates of `payment_term_id`; neither is used by any resolver.
6. `invoices.terms` is written with `term.name` (`InvoiceCreatePage.tsx:276`) — "Net 20" stamped into what is otherwise a free-text terms-and-conditions field, collapsing two concepts.
7. `recurring_invoices.days_before_due` is a third payment-term representation.

**P2 — coverage gaps**

8. Estimates, proformas, credit notes and POs have no `payment_term_id` even though estimates/proformas quote payment conditions.
9. Bills/POs/SOs/credit notes have no `terms` text and their snapshot builders force `terms: null`, so supplier-facing T&C cannot be printed.

**P3 — hygiene**

10. `AITextAssist` can freely overwrite `terms` — fine for prose, dangerous while that field doubles as a payment-term label.
11. The configured term is literally named `"Net  20"` (double space) — data quality.

---

## D. Merely confusing UX (not accounting problems)

- The invoice `Terms` textarea is ambiguously labelled; users read it as "payment terms" when it is a free-text T&C block.
- Bill create shows a term dropdown that silently persists nothing.
- Settings → Payment Terms makes the "default" affordance unobvious, which is why `is_default` stayed false.

---

## E. What is architecturally wrong

Three distinct business concepts have been collapsed into overlapping generic fields:

1. **Payment Term** — structured; computes a due date; drives AR/AP aging, overdue and dunning. Must be `payment_term_id` + snapshotted `due_date`.
2. **Terms & Conditions** — commercial/legal prose printed on a document. Belongs in a per-document text field seeded from a business-level default T&C, never from a term's `name`.
3. **Notes** — needs an explicit audience split: customer-facing document note vs internal note. `contacts.notes` has no declared audience today; `contacts.vendor_notes` exists separately with no stated rule.

And there are **three representations of the same term** (`payment_term_id` FK, integer `default_payment_terms` on two tables, `days_before_due`) with **no single resolution function**, so every screen re-invents the cascade.

---

## F. Domain model and dependency chain (target)

```text
        Business default term (payment_terms.is_default)
                       |
        Customer / Supplier default (contacts.payment_term_id,
                       |             suppliers.default_payment_term_id)
                       v
             Document-level override (user picks a term)
                       |
                       v
        resolve_payment_term()  ->  payment_term_id + due_date
                       |                       |
                 SNAPSHOT on document     rendered wording
                       |                  (separate T&C field)
        +--------------+--------------+
        v                             v
   AR/AP open items            Documents / PDFs
   aging, overdue,             (snapshot bytes, frozen)
   dunning, reports
```

Cross-domain consumers identified: Contacts (defaults), Sales (estimate, SO, proforma, invoice, credit note), Purchases (PO, bill), Finance (AR/AP open items, aging, overdue, allocation), Notifications (`sms_scan_overdue_invoices`), Reporting (receivables widgets, statements), Documents (snapshot builders), Audit.

Scope decision, evidence-based: keep resolution at **organization + business** (matching `payment_terms.business_id NOT NULL`). Do **not** introduce branch scoping — nothing in the data supports it.

---

## G. Convergence plan — phased, safest first

**Phase 0 — separate the concepts (no behaviour change)**
Define, in `docs/` and in project memory, the meanings: `payment_term_id` = structured term; `terms` = document T&C prose; `notes` = customer-facing document note; internal notes are a distinct field. Classify every existing `notes`/`terms` field against that table before touching any of them. Nothing deleted in this phase.

**Phase 1 — one resolver, one due-date rule (P0-2, P0-4)**
Add a single DB function `resolve_payment_term(org, business, contact_id, override_term_id)` returning `(payment_term_id, days)`, cascading override → contact/supplier → business default. Replace the three client rules with calls to it; remove the hardcoded `+30` and the hardcoded terms seed. When nothing resolves, fall back to due-on-receipt (issue date), not an invented 30 days.

**Phase 2 — close the bill gap (P0-1)**
Migration adding `bills.payment_term_id uuid REFERENCES payment_terms` with GRANTs matching existing bill policies; persist the picker's value. Historic bills keep their stored `due_date` as truth (backfill NULL).

**Phase 3 — carry the term through conversions (P0-3)**
Extend the conversion RPCs to copy/resolve `payment_term_id` alongside `due_date`; unify `recurring_invoices` onto the resolver, retiring `days_before_due` as the rule (column kept until data migrates).

**Phase 4 — un-collapse T&C from the term (P1-6)**
Stop writing `term.name` into `invoices.terms`. Seed `terms` from a business-level default T&C (`document_templates.terms_text` already exists and is the natural home). Printed payment wording is generated from the structured term at render time; the T&C field stays prose.

**Phase 5 — retire the duplicates (P1-5, P1-7)**
Once Phase 1 is proven, deprecate `businesses.default_payment_terms` and `contacts.default_payment_terms` — read-path removal first, column drop only after no reader remains.

**Phase 6 — coverage (P2)**
Add `payment_term_id` to estimates/proformas where quoted terms matter; give bills/POs/SOs a `terms` text field and stop forcing `terms: null` in those snapshot builders.

### Historical truth rule (non-negotiable)
A confirmed document's `payment_term_id` **and** `due_date` are snapshotted at confirmation and never re-resolved. Changing a customer from Net 30 to Net 15 must leave every existing invoice, its aging bucket, its overdue status and its PDF bytes unchanged, and affect only documents created afterwards.

### Acceptance scenarios to validate against
Customer with no term / Net 15 / Net 20 / due-on-receipt → invoice due dates 0/15/20 days; change the customer's term → old invoice unchanged, next invoice picks up the new term; per-invoice override honoured and snapshotted; AR aging bucket and `update_overdue_invoices` agree with the snapshotted due date; PDF wording matches the structured term; identical suite for suppliers → bills → AP aging.

---

## H. Explicitly NOT doing

- Not creating a second payment-terms table.
- Not touching journal posting, tax, allocation, credit-note netting or snapshot freezing.
- Not adding branch scoping.
- Not deleting any `notes` field in this work.
- Not re-resolving confirmed documents from live master data.
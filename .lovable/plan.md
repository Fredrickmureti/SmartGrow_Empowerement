# Sales Domain Wave — authoritative engineering record

Live per-phase ledger: `docs/plans/sales-domain-live-status.md`.
This file tracks the wave-level state and the active phase only.

## Verified complete

- **Phase 0–2** — upstream contract verification, lifecycle reconstruction,
  Product consumption (no Sales-local product tables; single server read seam).
- **Phase 3 — UoM & packaging.** `resolve_line_base_quantity` is the server
  authority; triggers on all five Sales line tables derive the base quantity
  from the customer-facing input and stamp the provenance columns.
- **Phase 4 — pricing / tax / totals.** `resolve_line_unit_price` and
  `resolve_line_tax_rate` are the active authorities; header totals are
  rewritten from the lines by `_sales_header_totals_guard`, so a disagreeing
  client value is corrected rather than trusted.
- **Phase 5 — availability.** Every line-capturing Sales editor consumes
  `useSalesLineAvailability` (server-resolved branch stock, per-document
  commit/advisory/none policy), guarded by
  `src/test/architecture/sales-availability-coverage.test.ts`.

## Phase 6 — Invoice ↔ Receivables boundary (in progress)

### 6.1 — server-side GL resolution — done

`build_invoice_je_lines(invoice_id)` is the single authority for the invoice
journal entry: receivable account (customer `default_receivable_account_id`
override, postable-checked, else `_resolve_canonical_default_account
('accounts_receivable')`), per-line revenue via `resolve_product_gl_account
(..., 'sales_revenue')` grouped by resolved account, `output_tax` for the tax
credit, and `discount_given` for a header discount (previously unposted, which
would have unbalanced any discounted invoice). Missing mappings raise
actionable errors instead of producing a lopsided entry.

`_confirm_invoice_core` now builds its own lines and *rejects* any
client-supplied `p_main_lines` (42501). `confirm_invoice_atomic` and
`confirm_invoice_and_release_stock_atomic` keep the parameter only as a
now-defaulted, refused legacy argument.

`src/hooks/invoices/confirmInvoiceGL.ts` is a thin RPC seam: no account
lookups, no journal-line assembly, no `p_main_lines`. Pinned by
`src/hooks/invoices/__tests__/confirmInvoiceGL.test.ts` (7 passing), whose
Supabase mock throws if the client reads a table for GL purposes.
`tsgo` is clean.

### 6.0 — one stock-evaluation type — done

`InvoiceLineRow` re-declared a local `StockEval`, so the shared
`LineStockEval` could not be passed into it. The row now imports
`LineStockEval` from `@/features/sales/availability`, and the coverage test
fails if any stock-rendering row re-declares the shape.

### 6.3 — invoices become a governed document — done

`invoices` was the least protected Sales document: the draft→posted rule lived
in a TypeScript `if`, and any client could write `status`, `invoice_number`,
`journal_entry_id` or `amount_paid` directly.

- `trg_00_invoices_governed_write` (mirrors
  `trg_00_sales_order_governed_write`, same PG_CONTEXT ownership mechanism)
  rejects a direct write to those four columns.
- `set_invoice_status_atomic` is the only sanctioned non-financial transition
  (sent / viewed / overdue / cancelled). It enforces server-side that a draft
  must be confirmed first, that a paid/voided invoice cannot be moved
  backwards, that settlement statuses are derived from payments, and that
  voiding goes through `void_invoice_atomic`.
- `link_invoice_journal_entry_atomic` gives the opening-balance importer a
  narrow link-once door instead of widening the guard.
- Callers migrated: `useInvoices.updateInvoiceStatus`,
  `useInvoicesPaginated.updateInvoiceStatus`, `MigrationStepOpenBalance`.

Totals are deliberately outside the reject list — Phase 4's totals guard
already rewrites them from the lines, which is stronger than rejection.

### Remaining Phase 6 work

1. **6.2 — atomic invoice creation (NEXT, active milestone).** Invoice creation is a two-step browser
   insert (header, then lines) with no idempotency key. Replace with
   `create_invoice_atomic(p_idempotency_key ...)`.

### Known pre-existing failure (not caused by Phase 6)

`src/test/architecture/recurring-invoicing-single-engine.test.ts` fails: the
`process-recurring-invoices` worker still writes `next_run_date` itself. This
predates this wave and belongs to the recurring-invoicing engine, not Sales
Phase 6 — record it, do not fold it into 6.2.

## Instructions for the next agent

1. **Verify 6.1 before writing code.** Confirm in the live database that
   `build_invoice_je_lines` exists and that `_confirm_invoice_core` raises on
   non-empty `p_main_lines`; confirm no client file constructs invoice journal
   lines (`rg -n "p_main_lines" src/` should only match generated types and
   guard tests). Then run the confirmInvoiceGL and
   compensation-writer-monopoly suites.
2. **Then resume at 6.2**, the next milestone in the roadmap — do not pick up
   unrelated work, and finish 6.2 (RPC + all client call sites + guard test +
   ledger update) before touching Phase 6b/7.
3. Every function-defining migration must end with `NOTIFY pgrst,
   'reload schema';` or the compensation-writer-monopoly guard fails.

## Verification standard

No claim enters this file or the ledger without evidence from the live
database or a passing guard test. The database currently holds zero invoices,
so 6.3 is evidenced by the trigger/function definitions and the migrated call
sites; behavioural proof (reject a direct status write, accept the engine
path) is recorded when transactional data exists.

## Out of scope until their phase

Warehouse selection (Phase 6b), sale-time tax resolver ownership (Phase 7),
idempotency across all Sales RPCs (Phase 10), reporting surfaces (Phase 14).

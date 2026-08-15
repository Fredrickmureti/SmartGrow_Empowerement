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

### 6.2 — atomic, idempotent invoice creation — done

Creation was a two-step browser insert (header, then lines) with
client-computed totals and no retry protection: a failure between the writes
left a headless invoice, and a double submit minted two numbered invoices.

- `create_invoice_atomic(p_header, p_items, p_user_id, p_idempotency_key)` —
  SECURITY DEFINER, business-access checked, always writes a `draft`, and
  writes header + lines in one transaction. The server owns the invoice
  number (`get_next_invoice_number`), the base quantity
  (`resolve_line_base_quantity`, rejecting a disagreeing client base
  quantity), all line money, the header totals and the exchange rate
  (`resolve_sales_exchange_rate`). Mirrors `create_sales_order_atomic`.
- `public.sales_document_idempotency` — unique on
  `(organization_id, document_type, idempotency_key)`, RLS-readable within the
  business. A replayed key returns the original response with
  `idempotent_replay: true` instead of creating a second invoice. Deliberately
  generic so Phase 10 can reuse it for the other Sales RPCs.
- Client seam `src/hooks/invoices/createInvoiceAtomic.ts` mints the key;
  `useInvoices.createInvoice` and `useInvoicesPaginated.createInvoice` both go
  through it and no longer insert rows or compute totals. The bill-to snapshot
  is frozen post-create through `freezeBillToSnapshot("invoices", ...)`.
- Pinned by `src/test/architecture/invoice-creation-atomic.test.ts` (6). Full
  run of the Phase 6 guards: 54 tests passing; `tsgo` clean.
- Documented exception: `MigrationStepOpenBalance` still bulk-inserts historic
  opening-balance invoices — importer path, not the Sales editor path.

**Phase 6 (Invoice ↔ Receivables) is complete: 6.0, 6.1, 6.2, 6.3.**

### Pending work (in roadmap order)

1. **Phase 6b — warehouse selection on Sales documents (NEXT, active
   milestone).**
2. Phase 7 — sale-time tax resolver ownership in the Tax domain.
3. Phase 9/10 — governed write path for estimates; idempotency across the
   remaining Sales RPCs, reusing `sales_document_idempotency`.
4. Phase 2 follow-up — manual product picker through the ADR 0114 identity
   read seam.

### Known pre-existing failure (not caused by Phase 6)

`src/test/architecture/recurring-invoicing-single-engine.test.ts` fails: the
`process-recurring-invoices` worker still writes `next_run_date` itself. This
predates this wave and belongs to the recurring-invoicing engine — record it,
do not fold it into a Sales phase.

## Instructions for the next agent

1. **Verify Phase 6 before writing code.**
   - `create_invoice_atomic` and `sales_document_idempotency` exist in the
     live database; the function is SECURITY DEFINER with
     `search_path = public` and checks `user_can_access_business`.
   - No Sales editor inserts invoice headers/lines:
     `rg -n 'from\("invoice' src/hooks src/features/sales` should show reads
     and the migration importer only.
   - `build_invoice_je_lines` exists and `_confirm_invoice_core` raises 42501
     on non-empty `p_main_lines`.
   - Run: `npx vitest run src/test/architecture/invoice-creation-atomic.test.ts
     src/hooks/invoices/__tests__/confirmInvoiceGL.test.ts
     src/test/architecture/compensation-writer-monopoly.test.ts
     src/test/architecture/sales-availability-coverage.test.ts` (54 expected)
     and `npx tsgo --noEmit`.
   - Behavioural proof still owed once transactional data exists: create an
     invoice twice with the same idempotency key and assert one row.
2. **Then resume at Phase 6b** (warehouse selection) — the next milestone in
   the roadmap. Do not pick up unrelated work; finish 6b end to end (server
   authority + every editor + guard test + ledger entry) before Phase 7.
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

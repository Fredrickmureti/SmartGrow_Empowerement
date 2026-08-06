
## Verified complete (this turn)

- **C6b contract checks (live DB):** `void_invoice_atomic`, `void_payment_atomic`,
  `void_bill_payment_atomic`, `unapply_payment_atomic`, `unreconcile_payment_atomic`
  each have exactly one overload, are SECURITY DEFINER with a pinned `search_path`,
  carry a fiscal-period guard, contain no raw journal inserts, and delete no
  settlement rows. The three `void_*` functions carry an `already_voided`
  short-circuit; `unapply_payment_atomic` short-circuits on `client_request_id`.
  `supabase/tests/bill_payment_reversal_test.sql` added for AP (contract + behavioural).
- **C7 advance recovery convergence:** already correct — `payroll_advance_recovery_gl_targets`
  resolves `employee_advance_receivable` (fallback `loan_receivable`), `post-payroll-gl`
  credits that receivable, and `payroll_required_gl_mappings_for_run` explicitly excludes
  `advance_recovery%` rule codes so no payable mapping is demanded.
- **Duplicate settlement writers removed:** the redundant 5-arg
  `confirm_invoice_and_release_stock_atomic` body was dropped (both copies defaulted
  status to `confirmed`; one implementation remains).
- **POS invoice writer unified (ADR 0128):** `usePOSInvoiceRequest` no longer inserts
  invoices/items or reserves invoice numbers on the client; it calls
  `create_pos_credit_sale_invoice_atomic(_mode := 'full')` and settles tenders through
  `record_payment_atomic`. Ratchets green.

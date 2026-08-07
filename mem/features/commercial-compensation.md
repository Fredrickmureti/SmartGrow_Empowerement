---
name: Commercial compensation architecture
description: Credit notes, customer + vendor credit ledgers, single refund engines, business-scoped numbering (ADR 0131 / 0132)
type: feature
---

ADR 0131 (AR) and ADR 0132 (AP) govern credit notes, credit balances and refunds.
Both sides follow the same rules — never let one drift from the other.

- A credit note is a commercial document. Issuing reverses revenue/expense + tax;
  the counter-leg is decided server-side: reduce AR/AP only up to the linked
  document's open balance, remainder becomes customer/vendor credit. The browser
  never decides this and never builds journal lines.
- Credit is a real balance: `customer_credit_balances` / `vendor_credit_balances`
  projected from append-only `customer_credit_movements` /
  `vendor_credit_movements` (issue/apply/refund/expire). Never derive
  availability from `total - amount_applied`.
- Dedicated GL accounts, separate from AR/AP and from customer prepayments:
  roles `customer_credit` (2215 Customer Credits) and `vendor_credit`
  (1215 Vendor Credits). System accounts are provisioned ONLY via
  `upsert_system_account()` — a direct INSERT into `accounts` is blocked.
  Tie-out views: `customer_credit_tieout`, `vendor_credit_tieout`; drift is
  recorded by `snapshot_control_account_drift()`.
- Canonical writers (AR): `create_credit_note_atomic`,
  `issue_credit_note_atomic`, `apply_credit_to_invoice_atomic`,
  `refund_customer_atomic`.
  (AP): `create_vendor_credit_note_atomic`, `issue_vendor_credit_note_atomic`,
  `apply_vendor_credit_to_bill_atomic`, `apply_vendor_credit_fifo_atomic`,
  `refund_from_vendor_atomic`.
  Retired with no fallback: `process_refund_atomic`,
  `confirm_vendor_credit_note_atomic`, `apply_vendor_credit_note_atomic`,
  and the client-side `postPurchaseReturnGL`.
  Posting still only via `post_journal_entry_atomic` (ADR 0123).
- Statements/aging read credit from the balance tables, not document columns.
- Inventory moves only through a return document (`sales_returns` linked by
  `credit_notes.source_return_id`); a credit note alone moves no stock.
  Contract test: `supabase/tests/compensation_inventory_boundary_test.sql`.
- Numbering is business-scoped and advisory-locked; prefixes live on
  `businesses`, NOT on `organizations`. No client-side fallback numbers.
- Ratchet: `src/test/architecture/compensation-writer-monopoly.test.ts`.

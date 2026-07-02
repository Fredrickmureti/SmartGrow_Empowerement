-- Enforce that invoices must have a customer (contact_id) unless they are still in draft or voided state.
-- This prevents accidentally confirming/sending/posting an invoice without a customer, which would
-- break AR subledger integrity (no party to bill, no AR balance traceability).

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_require_customer_when_active;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_require_customer_when_active
  CHECK (
    status IN ('draft', 'voided', 'cancelled')
    OR contact_id IS NOT NULL
  ) NOT VALID;

-- NOT VALID so existing rows are not retro-checked; new inserts/updates are enforced.

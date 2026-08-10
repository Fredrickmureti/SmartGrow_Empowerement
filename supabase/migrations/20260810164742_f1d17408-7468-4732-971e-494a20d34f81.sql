-- Step 2b (AP remediation): retire the stored `overdue` bill status.
-- Overdue is a derived condition (due_date < today AND balance > 0), not a
-- lifecycle state. Storing it destroyed the real state (received/partial)
-- and made the value stale the moment the clock moved.
-- The enum value is intentionally KEPT for back-compat with historical rows,
-- reports and client unions; nothing writes it any more.
DROP TRIGGER IF EXISTS trg_bill_overdue_check ON public.bills;
DROP FUNCTION IF EXISTS public.mark_overdue_bills();

-- Restore the real lifecycle state on rows the trigger had overwritten.
UPDATE public.bills
   SET status = CASE
                  WHEN COALESCE(amount_paid, 0) > 0 THEN 'partial'::bill_status
                  ELSE 'received'::bill_status
                END
 WHERE status = 'overdue'::bill_status;
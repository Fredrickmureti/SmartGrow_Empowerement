ALTER TABLE public.mf_client_charges
  ADD COLUMN IF NOT EXISTS paid_amount numeric(18,2) NOT NULL DEFAULT 0;

ALTER TABLE public.mf_client_charges
  DROP CONSTRAINT IF EXISTS mf_client_charges_status_known;

ALTER TABLE public.mf_client_charges
  ADD CONSTRAINT mf_client_charges_status_known
  CHECK (status IN ('outstanding','part_paid','paid','reversed'));

CREATE OR REPLACE FUNCTION public.mf_client_charge_recompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_charge uuid := COALESCE(NEW.charge_id, OLD.charge_id);
  ch public.mf_client_charges%ROWTYPE;
  v_paid numeric(18,2);
  v_last public.mf_client_charge_payments%ROWTYPE;
BEGIN
  SELECT * INTO ch FROM public.mf_client_charges WHERE id = v_charge FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_paid
    FROM public.mf_client_charge_payments
   WHERE charge_id = v_charge AND status = 'posted';

  IF v_paid > ch.amount + 0.005 THEN
    RAISE EXCEPTION 'Payments of % exceed the charge amount of %.', v_paid, ch.amount;
  END IF;

  SELECT * INTO v_last
    FROM public.mf_client_charge_payments
   WHERE charge_id = v_charge AND status = 'posted'
   ORDER BY paid_on DESC, created_at DESC
   LIMIT 1;

  UPDATE public.mf_client_charges
     SET paid_amount = v_paid,
         status = CASE
           WHEN ch.status = 'reversed' THEN 'reversed'
           WHEN v_paid <= 0 THEN 'outstanding'
           WHEN v_paid >= ch.amount - 0.005 THEN 'paid'
           ELSE 'part_paid' END,
         paid_on = CASE WHEN v_paid > 0 THEN v_last.paid_on ELSE NULL END,
         method = CASE WHEN v_paid > 0 THEN v_last.method ELSE NULL END,
         reference = CASE WHEN v_paid > 0 THEN v_last.reference ELSE NULL END,
         receipt_number = CASE WHEN v_paid > 0 THEN COALESCE(v_last.receipt_number, ch.receipt_number) ELSE ch.receipt_number END,
         journal_entry_id = CASE WHEN v_paid > 0 THEN v_last.journal_entry_id ELSE NULL END
   WHERE id = v_charge;

  RETURN NULL;
END;
$function$;

CREATE TRIGGER mf_ccp_recompute
  AFTER INSERT OR UPDATE OR DELETE ON public.mf_client_charge_payments
  FOR EACH ROW EXECUTE FUNCTION public.mf_client_charge_recompute();

-- Backfill: every already-settled charge becomes one settlement record.
INSERT INTO public.mf_client_charge_payments (
  business_id, branch_id, charge_id, client_id, amount, paid_on, method,
  reference, receipt_number, status, journal_entry_id, notes, created_by, created_at
)
SELECT ch.business_id, ch.branch_id, ch.id, ch.client_id, ch.amount,
       COALESCE(ch.paid_on, ch.charged_on), COALESCE(ch.method, 'cash'),
       ch.reference, ch.receipt_number, 'posted', ch.journal_entry_id,
       'Migrated from the original single-payment record.', ch.created_by, ch.created_at
  FROM public.mf_client_charges ch
 WHERE ch.status = 'paid'
   AND NOT EXISTS (SELECT 1 FROM public.mf_client_charge_payments p WHERE p.charge_id = ch.id);
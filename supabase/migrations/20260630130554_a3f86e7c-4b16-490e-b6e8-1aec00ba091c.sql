
CREATE OR REPLACE FUNCTION public.validate_payroll_payment_batch_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_old text := OLD.status::text;
  v_new text := NEW.status::text;
  v_allowed boolean := false;
BEGIN
  IF v_old = v_new THEN
    IF v_old IN ('paid','cancelled','reversed') THEN
      IF (NEW.total_amount IS DISTINCT FROM OLD.total_amount)
         OR (NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id)
         OR (NEW.payroll_run_id  IS DISTINCT FROM OLD.payroll_run_id)
         OR (NEW.batch_number    IS DISTINCT FROM OLD.batch_number) THEN
        RAISE EXCEPTION 'payroll_payment_batch %: terminal status (%); cannot mutate',
          OLD.id, v_old USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  v_allowed := CASE
    WHEN v_old = 'draft'          AND v_new IN ('approved','paid','cancelled')             THEN true
    WHEN v_old = 'pending'        AND v_new IN ('approved','paid','cancelled')             THEN true
    WHEN v_old = 'approved'      AND v_new IN ('locked','paid','cancelled')                THEN true
    WHEN v_old = 'locked'        AND v_new IN ('exported','paid','cancelled','failed')     THEN true
    WHEN v_old = 'exported'      AND v_new IN ('transmitted','paid','failed','cancelled')  THEN true
    WHEN v_old = 'transmitted'   AND v_new IN ('partially_paid','paid','failed')           THEN true
    WHEN v_old = 'partially_paid' AND v_new IN ('paid','failed')                           THEN true
    WHEN v_old = 'failed'        AND v_new IN ('locked','exported','transmitted','paid','cancelled') THEN true
    WHEN v_old = 'paid'          AND v_new = 'reversed'                                    THEN true
    WHEN v_old = 'confirmed'     AND v_new IN ('partially_paid','paid','failed')           THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'payroll_payment_batch %: illegal transition % -> %',
      OLD.id, v_old, v_new USING ERRCODE = '42501', HINT = 'PPB_INVALID_TRANSITION';
  END IF;

  IF v_new = 'approved'    AND (NEW.approved_by    IS NULL OR NEW.approved_at    IS NULL) THEN RAISE EXCEPTION 'approved transition requires approved_by/at'    USING ERRCODE='42501'; END IF;
  IF v_new = 'locked'      AND (NEW.locked_by      IS NULL OR NEW.locked_at      IS NULL) THEN RAISE EXCEPTION 'locked transition requires locked_by/at'        USING ERRCODE='42501'; END IF;
  IF v_new = 'exported'    AND (NEW.exported_by    IS NULL OR NEW.exported_at    IS NULL) THEN RAISE EXCEPTION 'exported transition requires exported_by/at'    USING ERRCODE='42501'; END IF;
  IF v_new = 'transmitted' AND (NEW.transmitted_by IS NULL OR NEW.transmitted_at IS NULL) THEN RAISE EXCEPTION 'transmitted transition requires transmitted_by/at' USING ERRCODE='42501'; END IF;
  IF v_new = 'paid'        AND NEW.paid_at IS NULL THEN NEW.paid_at := now(); END IF;
  IF v_new = 'cancelled'   AND (NEW.cancelled_by   IS NULL OR NEW.cancelled_at   IS NULL) THEN RAISE EXCEPTION 'cancelled transition requires cancelled_by/at'  USING ERRCODE='42501'; END IF;
  IF v_new = 'reversed'    AND (NEW.reversed_by    IS NULL OR NEW.reversed_at    IS NULL) THEN RAISE EXCEPTION 'reversed transition requires reversed_by/at'    USING ERRCODE='42501'; END IF;

  RETURN NEW;
END
$$;

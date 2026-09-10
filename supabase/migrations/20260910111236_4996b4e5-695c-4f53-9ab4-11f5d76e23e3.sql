CREATE OR REPLACE FUNCTION public._mf_lpv_freeze_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_published
       AND coalesce(current_setting('app.reset_in_progress', true), '') = ''
       AND coalesce(current_setting('app.mf_product_purge', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Published loan product versions cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_published THEN
    IF NEW.is_published IS DISTINCT FROM OLD.is_published
       OR NEW.min_amount IS DISTINCT FROM OLD.min_amount
       OR NEW.max_amount IS DISTINCT FROM OLD.max_amount
       OR NEW.min_term_installments IS DISTINCT FROM OLD.min_term_installments
       OR NEW.max_term_installments IS DISTINCT FROM OLD.max_term_installments
       OR NEW.repayment_frequency IS DISTINCT FROM OLD.repayment_frequency
       OR NEW.interest_method IS DISTINCT FROM OLD.interest_method
       OR NEW.interest_rate IS DISTINCT FROM OLD.interest_rate
       OR NEW.interest_rate_period IS DISTINCT FROM OLD.interest_rate_period
       OR NEW.grace_period_installments IS DISTINCT FROM OLD.grace_period_installments
       OR NEW.fees IS DISTINCT FROM OLD.fees
       OR NEW.penalty_rate IS DISTINCT FROM OLD.penalty_rate
       OR NEW.penalty_basis IS DISTINCT FROM OLD.penalty_basis
       OR NEW.eligibility IS DISTINCT FROM OLD.eligibility
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
       OR NEW.version_no IS DISTINCT FROM OLD.version_no THEN
      RAISE EXCEPTION 'Published loan product versions are immutable — publish a new version instead';
    END IF;
  END IF;

  NEW.updated_at := now();
  IF NEW.is_published AND OLD.is_published = false THEN
    NEW.published_at := now();
  END IF;
  RETURN NEW;
END;
$function$;
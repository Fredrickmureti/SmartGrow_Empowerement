
ALTER TABLE public.payroll_work_entry_types
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION public.bump_payroll_wet_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only bump when a caller-visible column actually changed, not on
  -- system-only touch-ups. updated_at is intentionally excluded.
  IF (TG_OP = 'UPDATE') THEN
    IF ROW(NEW.code, NEW.name, NEW.color, NEW.is_paid, NEW.is_unpaid_leave,
           NEW.counts_as_worked, NEW.multiplier_normal, NEW.multiplier_overtime,
           NEW.accounting_tag, NEW.sequence, NEW.is_active, NEW.business_id,
           NEW.localization_pack_id)
       IS DISTINCT FROM
       ROW(OLD.code, OLD.name, OLD.color, OLD.is_paid, OLD.is_unpaid_leave,
           OLD.counts_as_worked, OLD.multiplier_normal, OLD.multiplier_overtime,
           OLD.accounting_tag, OLD.sequence, OLD.is_active, OLD.business_id,
           OLD.localization_pack_id) THEN
      NEW.version := COALESCE(OLD.version, 1) + 1;
    ELSE
      NEW.version := OLD.version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_payroll_wet_version ON public.payroll_work_entry_types;
CREATE TRIGGER trg_bump_payroll_wet_version
  BEFORE UPDATE ON public.payroll_work_entry_types
  FOR EACH ROW EXECUTE FUNCTION public.bump_payroll_wet_version();

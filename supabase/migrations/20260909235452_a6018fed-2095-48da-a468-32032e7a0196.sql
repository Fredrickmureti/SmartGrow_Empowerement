CREATE OR REPLACE FUNCTION public.is_period_open(_business_id uuid, _post_date date)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_open boolean;
BEGIN
  IF to_regclass('public.fiscal_periods') IS NULL THEN
    RETURN true; -- No period model → permissive default.
  END IF;

  -- A period is closed when EITHER marker says so. `close_fiscal_period`
  -- writes `status`, older rows carry `is_closed`; reading only one of them
  -- let postings into closed months.
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.fiscal_periods fp
     WHERE fp.business_id = _business_id
       AND _post_date BETWEEN fp.start_date AND fp.end_date
       AND (COALESCE(fp.is_closed, false) = true OR fp.status = 'closed')
  ) INTO is_open;

  RETURN COALESCE(is_open, true);
END;
$$;
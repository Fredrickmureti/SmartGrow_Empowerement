CREATE OR REPLACE FUNCTION public.pos_resolve_cashier_fk(
  _cashier_or_user_id uuid,
  _business_id uuid,
  _branch_id uuid,
  _organization_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cashier_id uuid;
BEGIN
  IF _cashier_or_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT c.id
    INTO v_cashier_id
  FROM public.pos_cashiers c
  WHERE c.id = _cashier_or_user_id
    AND c.business_id = _business_id
    AND (_branch_id IS NULL OR c.branch_id = _branch_id)
    AND (_organization_id IS NULL OR c.organization_id = _organization_id)
    AND COALESCE(c.is_active, true) = true
  LIMIT 1;

  IF v_cashier_id IS NOT NULL THEN
    RETURN v_cashier_id;
  END IF;

  SELECT c.id
    INTO v_cashier_id
  FROM public.pos_cashiers c
  WHERE c.user_id = _cashier_or_user_id
    AND c.business_id = _business_id
    AND (_branch_id IS NULL OR c.branch_id = _branch_id)
    AND (_organization_id IS NULL OR c.organization_id = _organization_id)
    AND COALESCE(c.is_active, true) = true
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT 1;

  RETURN v_cashier_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pos_resolve_cashier_fk(uuid, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pos_resolve_cashier_fk(uuid, uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_pos_normalize_cashier_fk()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_TABLE_NAME = 'pos_shifts' THEN
    NEW.cashier_id := public.pos_resolve_cashier_fk(
      COALESCE(NEW.cashier_id, NEW.user_id),
      NEW.business_id,
      NEW.branch_id,
      NEW.organization_id
    );
  ELSE
    NEW.cashier_id := public.pos_resolve_cashier_fk(
      NEW.cashier_id,
      NEW.business_id,
      NEW.branch_id,
      NEW.organization_id
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_pos_payment_sessions_normalize_cashier_fk ON public.pos_payment_sessions;
CREATE TRIGGER zz_pos_payment_sessions_normalize_cashier_fk
BEFORE INSERT OR UPDATE OF cashier_id, business_id, branch_id, organization_id
ON public.pos_payment_sessions
FOR EACH ROW
EXECUTE FUNCTION public.tg_pos_normalize_cashier_fk();

DROP TRIGGER IF EXISTS zz_pos_shifts_normalize_cashier_fk ON public.pos_shifts;
CREATE TRIGGER zz_pos_shifts_normalize_cashier_fk
BEFORE INSERT OR UPDATE OF cashier_id, user_id, business_id, branch_id, organization_id
ON public.pos_shifts
FOR EACH ROW
EXECUTE FUNCTION public.tg_pos_normalize_cashier_fk();

DROP TRIGGER IF EXISTS zz_pos_transactions_normalize_cashier_fk ON public.pos_transactions;
CREATE TRIGGER zz_pos_transactions_normalize_cashier_fk
BEFORE INSERT OR UPDATE OF cashier_id, business_id, branch_id, organization_id
ON public.pos_transactions
FOR EACH ROW
EXECUTE FUNCTION public.tg_pos_normalize_cashier_fk();

UPDATE public.pos_payment_sessions s
   SET cashier_id = public.pos_resolve_cashier_fk(s.cashier_id, s.business_id, s.branch_id, s.organization_id)
 WHERE s.cashier_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.pos_cashiers c WHERE c.id = s.cashier_id
   );

UPDATE public.pos_shifts s
   SET cashier_id = public.pos_resolve_cashier_fk(COALESCE(s.cashier_id, s.user_id), s.business_id, s.branch_id, s.organization_id)
 WHERE s.cashier_id IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.pos_cashiers c WHERE c.id = s.cashier_id
    );
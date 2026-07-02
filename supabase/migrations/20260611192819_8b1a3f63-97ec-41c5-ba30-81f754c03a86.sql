
-- =========================================================================
-- SoD Wave G5 — Sensitive Field Framework: bank account routing fields
-- =========================================================================

-- 1) Audit table -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sensitive_field_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  table_name      text NOT NULL,
  record_id       uuid NOT NULL,
  column_name     text NOT NULL,
  old_value_masked text,
  new_value_masked text,
  action_key      text,
  changed_by      uuid,
  override_id     uuid REFERENCES public.self_action_overrides(id) ON DELETE SET NULL,
  changed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sensitive_field_audit_org_time_idx
  ON public.sensitive_field_audit (organization_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS sensitive_field_audit_record_idx
  ON public.sensitive_field_audit (table_name, record_id);

GRANT SELECT ON public.sensitive_field_audit TO authenticated;
GRANT ALL    ON public.sensitive_field_audit TO service_role;

ALTER TABLE public.sensitive_field_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners and admins can view their org's sensitive audit"
  ON public.sensitive_field_audit;
CREATE POLICY "Owners and admins can view their org's sensitive audit"
  ON public.sensitive_field_audit FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'super_admin')
    OR public.has_role(auth.uid(), 'admin')
  );

-- 2) Mask helper -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mask_sensitive_value(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_value IS NULL OR length(p_value) = 0 THEN NULL
    WHEN length(p_value) <= 4 THEN repeat('*', length(p_value))
    ELSE repeat('*', length(p_value) - 4) || right(p_value, 4)
  END;
$$;

-- 3) Trigger function on bank_accounts ------------------------------------
CREATE OR REPLACE FUNCTION public.trg_sod_bank_accounts_sensitive_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_override_id uuid;
  v_changes jsonb := '[]'::jsonb;
BEGIN
  -- Teardown bypass.
  IF public._is_teardown_for_org(NEW.organization_id) THEN
    RETURN NEW;
  END IF;

  -- Detect changes to sensitive columns.
  IF (NEW.account_number IS DISTINCT FROM OLD.account_number) THEN
    v_changes := v_changes || jsonb_build_object('col','account_number',
                                                  'old', OLD.account_number,
                                                  'new', NEW.account_number);
  END IF;
  IF (NEW.routing_number IS DISTINCT FROM OLD.routing_number) THEN
    v_changes := v_changes || jsonb_build_object('col','routing_number',
                                                  'old', OLD.routing_number,
                                                  'new', NEW.routing_number);
  END IF;

  IF jsonb_array_length(v_changes) = 0 THEN
    RETURN NEW;
  END IF;

  -- Route through governance: subject = actor, so it always trips the
  -- self-action check. Mode determines allow / warn / block.
  PERFORM public.governance_assert_not_self(
    v_actor, v_actor, 'bank_account.sensitive_change',
    NEW.organization_id, 'bank_account', NEW.id
  );

  -- If an override was just consumed, capture it for the audit row.
  SELECT id INTO v_override_id
    FROM public.self_action_overrides
   WHERE organization_id = NEW.organization_id
     AND action_key      = 'bank_account.sensitive_change'
     AND actor_user_id   = v_actor
     AND consumed_at IS NOT NULL
     AND consumed_at > now() - interval '5 seconds'
   ORDER BY consumed_at DESC
   LIMIT 1;

  -- Write one audit row per changed column.
  INSERT INTO public.sensitive_field_audit
    (organization_id, table_name, record_id, column_name,
     old_value_masked, new_value_masked, action_key, changed_by, override_id)
  SELECT NEW.organization_id, 'bank_accounts', NEW.id,
         c->>'col',
         public.mask_sensitive_value(c->>'old'),
         public.mask_sensitive_value(c->>'new'),
         'bank_account.sensitive_change',
         v_actor, v_override_id
    FROM jsonb_array_elements(v_changes) AS c;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sod_bank_accounts_guard ON public.bank_accounts;
CREATE TRIGGER sod_bank_accounts_guard
  BEFORE UPDATE ON public.bank_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_sod_bank_accounts_sensitive_change();

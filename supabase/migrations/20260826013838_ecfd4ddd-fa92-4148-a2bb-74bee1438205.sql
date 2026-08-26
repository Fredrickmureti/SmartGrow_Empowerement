-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2 — Rate-book integrity and privilege (D4, D5, S1)
-- The rate book becomes append-only evidence: corrections are new dated rows,
-- never edits. Writing a rate is a finance-manager privilege. Tenant-entered
-- rates may not be dated into a closed accounting period.
-- Nothing here touches rate precedence, provider publishing, or any stamped rate.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Audit trail ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.exchange_rate_audit (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  business_id       uuid NOT NULL,
  exchange_rate_id  uuid NOT NULL,
  from_currency     text NOT NULL,
  to_currency       text NOT NULL,
  effective_date    date NOT NULL,
  source            text NOT NULL,
  rate              numeric NOT NULL,
  prior_rate        numeric,
  prior_rate_id     uuid,
  prior_source      text,
  prior_effective_date date,
  reason            text,
  actor_id          uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.exchange_rate_audit IS
  'Append-only provenance for every exchange-rate row recorded: actor, stated reason, and the rate the new row supersedes for that pair and date.';

CREATE INDEX IF NOT EXISTS idx_exchange_rate_audit_pair
  ON public.exchange_rate_audit (business_id, from_currency, to_currency, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_exchange_rate_audit_rate
  ON public.exchange_rate_audit (exchange_rate_id);

GRANT SELECT ON public.exchange_rate_audit TO authenticated;
GRANT ALL    ON public.exchange_rate_audit TO service_role;

ALTER TABLE public.exchange_rate_audit ENABLE ROW LEVEL SECURITY;

-- Read-only to finance managers of the company. No client write path exists:
-- rows are written by the SECURITY DEFINER trigger below.
CREATE POLICY exchange_rate_audit_select
  ON public.exchange_rate_audit
  FOR SELECT
  TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.is_finance_manager(auth.uid(), organization_id)
  );

-- 2. Absolute immutability of recorded rates ─────────────────────────────────
CREATE OR REPLACE FUNCTION public._tg_exchange_rates_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- A rate is historical evidence. Once recorded it is never edited or removed,
  -- whatever its source: a document posted against it must remain explainable.
  -- Corrections are recorded as a new dated row, which outranks this one.
  RAISE EXCEPTION
    'Exchange rates are immutable (id %, %/% on %). Record a new dated rate instead of changing this one.',
    OLD.id, OLD.from_currency, OLD.to_currency, OLD.effective_date
    USING ERRCODE = '23514';
END;
$function$;

DROP TRIGGER IF EXISTS tg_exchange_rates_immutable_provider ON public.exchange_rates;
DROP TRIGGER IF EXISTS tg_exchange_rates_immutable ON public.exchange_rates;
CREATE TRIGGER tg_exchange_rates_immutable
  BEFORE UPDATE OR DELETE ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public._tg_exchange_rates_immutable();

DROP FUNCTION IF EXISTS public._tg_exchange_rates_immutable_provider();

-- 3. Write guard: privilege + closed-period rejection ────────────────────────
CREATE OR REPLACE FUNCTION public._tg_exchange_rates_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.rate IS NULL OR NEW.rate <= 0 THEN
    RAISE EXCEPTION 'An exchange rate must be greater than zero' USING ERRCODE = '22023';
  END IF;

  -- Interactive callers must be finance managers. A NULL actor is the provider
  -- publishing job (service role); its privilege is the key it runs with.
  IF v_actor IS NOT NULL THEN
    IF NOT public.user_can_access_business(v_actor, NEW.business_id) THEN
      RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
    END IF;
    IF NOT public.is_finance_manager(v_actor, NEW.organization_id) THEN
      RAISE EXCEPTION 'Recording an exchange rate requires a finance role (owner, admin or accountant)'
        USING ERRCODE = '42501';
    END IF;
    NEW.created_by := COALESCE(NEW.created_by, v_actor);
  END IF;

  -- A tenant-entered rate dated into a closed period would silently rewrite the
  -- basis of already-reported figures. Provider publishing is deliberately exempt:
  -- it is reference data, and resolution still prefers a tenant override.
  IF NEW.source <> 'provider' AND EXISTS (
    SELECT 1 FROM public.fiscal_periods fp
     WHERE fp.business_id = NEW.business_id
       AND NEW.effective_date BETWEEN fp.start_date AND fp.end_date
       AND fp.status::text <> 'open'
  ) THEN
    RAISE EXCEPTION
      'The accounting period covering % is closed; an exchange rate cannot be dated into it. Reopen the period or date the rate in an open one.',
      NEW.effective_date
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tg_exchange_rates_write_guard ON public.exchange_rates;
CREATE TRIGGER tg_exchange_rates_write_guard
  BEFORE INSERT ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public._tg_exchange_rates_write_guard();

-- 4. Audit capture ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._tg_exchange_rates_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prior record;
  v_reason text := NULLIF(btrim(COALESCE(current_setting('app.fx_rate_reason', true), '')), '');
BEGIN
  -- The rate this row supersedes for the same pair and date, resolved with the
  -- one precedence rule so the audit reflects what the engine would have used.
  SELECT er.id, er.rate, er.source, er.effective_date
    INTO v_prior
    FROM public.exchange_rates er
   WHERE er.organization_id = NEW.organization_id
     AND er.business_id = NEW.business_id
     AND er.from_currency = NEW.from_currency
     AND er.to_currency = NEW.to_currency
     AND er.effective_date <= NEW.effective_date
     AND er.id <> NEW.id
   ORDER BY er.effective_date DESC,
            CASE er.source WHEN 'override' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END,
            er.published_at DESC
   LIMIT 1;

  INSERT INTO public.exchange_rate_audit (
    organization_id, business_id, exchange_rate_id,
    from_currency, to_currency, effective_date, source, rate,
    prior_rate, prior_rate_id, prior_source, prior_effective_date,
    reason, actor_id
  ) VALUES (
    NEW.organization_id, NEW.business_id, NEW.id,
    NEW.from_currency, NEW.to_currency, NEW.effective_date, NEW.source, NEW.rate,
    v_prior.rate, v_prior.id, v_prior.source, v_prior.effective_date,
    v_reason, auth.uid()
  );

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS tg_exchange_rates_audit ON public.exchange_rates;
CREATE TRIGGER tg_exchange_rates_audit
  AFTER INSERT ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public._tg_exchange_rates_audit();

-- 5. Privilege at the policy layer (S1) ──────────────────────────────────────
DROP POLICY IF EXISTS exchange_rates_all ON public.exchange_rates;

-- Reading the rate book stays broad: everyone working in the company sees the
-- rates their documents are valued at.
DROP POLICY IF EXISTS exchange_rates_select ON public.exchange_rates;
CREATE POLICY exchange_rates_select
  ON public.exchange_rates
  FOR SELECT
  TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

-- Recording a rate is a finance-manager act. There is deliberately no UPDATE and
-- no DELETE policy: the rate book is append-only.
CREATE POLICY exchange_rates_insert
  ON public.exchange_rates
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND public.is_finance_manager(auth.uid(), organization_id)
  );

REVOKE UPDATE, DELETE ON public.exchange_rates FROM authenticated;
REVOKE ALL ON public.exchange_rates FROM anon;
GRANT SELECT, INSERT ON public.exchange_rates TO authenticated;
GRANT ALL ON public.exchange_rates TO service_role;

-- 6. Carry the stated reason from the override RPC into the audit trail ──────
CREATE OR REPLACE FUNCTION public.set_exchange_rate_override(
  p_business_id uuid,
  p_from_currency text,
  p_to_currency text,
  p_rate numeric,
  p_effective_date date DEFAULT CURRENT_DATE,
  p_reason text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_org uuid;
  v_from text;
  v_to text;
  v_id uuid;
  v_reason text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_access_business(auth.uid(), p_business_id) THEN
    RAISE EXCEPTION 'Not authorised for this company' USING ERRCODE = '42501';
  END IF;

  SELECT organization_id INTO v_org FROM public.businesses WHERE id = p_business_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Business % not found', p_business_id;
  END IF;

  IF NOT public.is_finance_manager(auth.uid(), v_org) THEN
    RAISE EXCEPTION 'Recording an exchange rate requires a finance role (owner, admin or accountant)'
      USING ERRCODE = '42501';
  END IF;

  v_from := public.normalize_currency_code(p_from_currency);
  v_to := public.normalize_currency_code(p_to_currency);
  IF v_from IS NULL OR v_to IS NULL THEN
    RAISE EXCEPTION 'Both currencies are required' USING ERRCODE = '22023';
  END IF;
  IF v_from = v_to THEN
    RAISE EXCEPTION 'An override needs two different currencies' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = v_from AND is_active)
     OR NOT EXISTS (SELECT 1 FROM public.currencies WHERE code = v_to AND is_active) THEN
    RAISE EXCEPTION 'Unknown or inactive currency code' USING ERRCODE = '22023';
  END IF;
  IF p_rate IS NULL OR p_rate <= 0 THEN
    RAISE EXCEPTION 'Rate must be greater than zero' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_effective_date, CURRENT_DATE) > CURRENT_DATE + 1 THEN
    RAISE EXCEPTION 'Override effective date cannot be in the future' USING ERRCODE = '22023';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A reason is required when recording an override' USING ERRCODE = '22023';
  END IF;

  -- Transaction-local, read by the audit trigger. Corrections are new rows.
  PERFORM set_config('app.fx_rate_reason', v_reason, true);

  INSERT INTO public.exchange_rates (
    organization_id, business_id, from_currency, to_currency, rate,
    effective_date, source, created_by
  ) VALUES (
    v_org, p_business_id, v_from, v_to, p_rate,
    COALESCE(p_effective_date, CURRENT_DATE), 'override', auth.uid()
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    organization_id, business_id, user_id, action, entity_type, entity_id,
    entity_name, new_values, changes_summary
  ) VALUES (
    v_org, p_business_id, auth.uid(), 'exchange_rate.override', 'exchange_rate', v_id,
    v_from || '/' || v_to,
    jsonb_build_object('rate', p_rate, 'effective_date', COALESCE(p_effective_date, CURRENT_DATE), 'source', 'override'),
    v_reason
  );

  PERFORM set_config('app.fx_rate_reason', '', true);
  RETURN v_id;
END;
$function$;
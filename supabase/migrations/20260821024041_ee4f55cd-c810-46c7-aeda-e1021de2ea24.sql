CREATE TABLE public.ai_advisory_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid,
  user_id uuid NOT NULL,
  feature text NOT NULL,
  action text NOT NULL,
  model_used text,
  was_degraded boolean NOT NULL DEFAULT false,
  was_throttled boolean NOT NULL DEFAULT false,
  response_time_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_advisory_usage_window_idx
  ON public.ai_advisory_usage (user_id, business_id, created_at DESC);

GRANT SELECT ON public.ai_advisory_usage TO authenticated;
GRANT ALL ON public.ai_advisory_usage TO service_role;

ALTER TABLE public.ai_advisory_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Reconcilers read their business advisory usage"
  ON public.ai_advisory_usage
  FOR SELECT
  TO authenticated
  USING (public.has_finance_permission(auth.uid(), 'finance.reconcile_bank', business_id));

COMMENT ON TABLE public.ai_advisory_usage IS
  'Cost and rate accounting for advisory AI. Not authoritative for accounting; written only by reconciliation_assistant_consume_quota / _record_outcome.';

CREATE OR REPLACE FUNCTION public.reconciliation_assistant_consume_quota(
  _bank_transaction_id uuid,
  _action text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_business_id uuid;
  v_branch_id uuid;
  v_user uuid := auth.uid();
  v_per_minute constant integer := 10;
  v_per_hour constant integer := 100;
  v_minute_count integer;
  v_hour_count integer;
  v_usage_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  IF _action NOT IN ('rank_candidates', 'explain_history') THEN
    RAISE EXCEPTION 'UNKNOWN_ADVISORY_ACTION: %', _action USING ERRCODE = '22023';
  END IF;

  SELECT bt.business_id, bt.branch_id
    INTO v_business_id, v_branch_id
  FROM public.bank_transactions bt
  WHERE bt.id = _bank_transaction_id;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- Same authority as reconciling the line itself: the assistant may never be
  -- a way to look at a line the caller could not open.
  PERFORM public.assert_can_reconcile_bank(v_business_id);

  SELECT count(*) FILTER (WHERE created_at > now() - interval '1 minute'),
         count(*) FILTER (WHERE created_at > now() - interval '1 hour')
    INTO v_minute_count, v_hour_count
  FROM public.ai_advisory_usage
  WHERE user_id = v_user
    AND business_id = v_business_id
    AND created_at > now() - interval '1 hour';

  IF v_minute_count >= v_per_minute OR v_hour_count >= v_per_hour THEN
    INSERT INTO public.ai_advisory_usage
      (business_id, branch_id, user_id, feature, action, was_throttled)
    VALUES
      (v_business_id, v_branch_id, v_user, 'reconciliation_assistant', _action, true);

    RETURN jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', CASE WHEN v_minute_count >= v_per_minute THEN 60 ELSE 900 END,
      'limit_window', CASE WHEN v_minute_count >= v_per_minute THEN 'minute' ELSE 'hour' END
    );
  END IF;

  INSERT INTO public.ai_advisory_usage
    (business_id, branch_id, user_id, feature, action)
  VALUES
    (v_business_id, v_branch_id, v_user, 'reconciliation_assistant', _action)
  RETURNING id INTO v_usage_id;

  RETURN jsonb_build_object('allowed', true, 'usage_id', v_usage_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconciliation_assistant_record_outcome(
  _usage_id uuid,
  _model_used text,
  _was_degraded boolean,
  _response_time_ms integer
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  UPDATE public.ai_advisory_usage
     SET model_used = _model_used,
         was_degraded = coalesce(_was_degraded, false),
         response_time_ms = _response_time_ms
   WHERE id = _usage_id
     AND user_id = auth.uid();
END;
$function$;

REVOKE ALL ON FUNCTION public.reconciliation_assistant_consume_quota(uuid, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.reconciliation_assistant_record_outcome(uuid, text, boolean, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reconciliation_assistant_consume_quota(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliation_assistant_record_outcome(uuid, text, boolean, integer) TO authenticated;
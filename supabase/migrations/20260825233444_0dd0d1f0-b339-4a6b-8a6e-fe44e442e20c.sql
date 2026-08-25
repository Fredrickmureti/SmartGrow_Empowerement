CREATE OR REPLACE FUNCTION public.complete_project_milestone(
  _milestone_id uuid,
  _reached boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_ms public.project_milestones%ROWTYPE;
  v_project public.projects%ROWTYPE;
  v_reached_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_ms FROM public.project_milestones WHERE id = _milestone_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'milestone_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_project FROM public.projects WHERE id = v_ms.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.project_can_write(v_project.id, v_uid) THEN
    RAISE EXCEPTION 'not_authorized_for_project' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: completing an already-reached milestone is a no-op, not an error.
  IF COALESCE(v_ms.is_reached, false) = COALESCE(_reached, false) THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true,
                              'is_reached', COALESCE(v_ms.is_reached, false));
  END IF;

  IF NOT _reached AND COALESCE(v_ms.is_invoiced, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'milestone_already_invoiced',
                              'invoice_id', v_ms.invoice_id);
  END IF;

  v_reached_at := CASE WHEN _reached THEN now() ELSE NULL END;

  PERFORM set_config('app.project_milestone_privileged', 'on', true);

  UPDATE public.project_milestones
     SET is_reached = _reached,
         reached_at = v_reached_at,
         updated_at = now()
   WHERE id = _milestone_id;

  PERFORM set_config('app.project_milestone_privileged', 'off', true);

  INSERT INTO public.project_activity_log (
    organization_id, business_id, project_id, milestone_id, actor_id,
    event_type, summary, payload
  ) VALUES (
    v_project.organization_id, v_project.business_id, v_project.id, v_ms.id, v_uid,
    CASE WHEN _reached THEN 'milestone.reached' ELSE 'milestone.reopened' END,
    CASE WHEN _reached THEN 'Milestone reached: ' ELSE 'Milestone reopened: ' END || v_ms.name,
    jsonb_build_object('milestone_id', v_ms.id, 'billing_amount', v_ms.billing_amount)
  );

  INSERT INTO public.business_event_outbox (
    org_id, branch_id, event_type, source_doc_type, source_doc_id,
    payload, idempotency_key, actor_user_id, source
  ) VALUES (
    v_project.organization_id, v_project.branch_id,
    CASE WHEN _reached THEN 'projects.milestone.reached' ELSE 'projects.milestone.reopened' END,
    'project_milestone', v_ms.id,
    jsonb_build_object(
      'project_id', v_project.id,
      'business_id', v_project.business_id,
      'branch_id', v_project.branch_id,
      'milestone_id', v_ms.id,
      'milestone_name', v_ms.name,
      'billing_amount', v_ms.billing_amount,
      'currency', v_project.currency,
      'is_reached', _reached
    ),
    'projects.milestone.' || CASE WHEN _reached THEN 'reached' ELSE 'reopened' END
      || ':' || v_ms.id::text || ':' || COALESCE(v_reached_at, now())::text,
    v_uid,
    'app'
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'is_reached', _reached, 'reached_at', v_reached_at);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_project_milestone(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_project_milestone(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_project_milestone(uuid, boolean) TO service_role;
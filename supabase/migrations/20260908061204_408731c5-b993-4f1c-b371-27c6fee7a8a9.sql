CREATE OR REPLACE FUNCTION public.cancel_ownership_transfer(p_transfer_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_t public.organization_ownership_transfers;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_t
    FROM public.organization_ownership_transfers
   WHERE id = p_transfer_id
   FOR UPDATE;

  IF v_t.id IS NULL THEN
    RAISE EXCEPTION 'Transfer not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_actor NOT IN (v_t.from_user_id, v_t.to_user_id) THEN
    RAISE EXCEPTION 'Only the owner or the nominated recipient can cancel this transfer.'
      USING ERRCODE = '42501';
  END IF;

  IF v_t.status <> 'pending' THEN
    RAISE EXCEPTION 'This transfer is no longer pending.' USING ERRCODE = '22023';
  END IF;

  UPDATE public.organization_ownership_transfers
     SET status = 'cancelled', responded_at = now()
   WHERE id = p_transfer_id;

  INSERT INTO public.audit_logs (
    organization_id, user_id, action, entity_type, entity_id, new_values, changes_summary
  ) VALUES (
    v_t.organization_id, v_actor, 'ownership_transfer_cancelled',
    'organization_ownership_transfer', p_transfer_id,
    jsonb_build_object('cancelled_by', v_actor),
    'Ownership transfer cancelled'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_ownership_transfer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_ownership_transfer(uuid) TO authenticated;
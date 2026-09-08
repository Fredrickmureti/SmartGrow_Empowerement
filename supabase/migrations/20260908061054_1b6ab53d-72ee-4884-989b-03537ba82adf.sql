CREATE OR REPLACE FUNCTION public.propose_ownership_transfer(
  p_organization_id uuid,
  p_to_user_id uuid,
  p_note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = p_organization_id AND o.owner_user_id = v_actor
  ) THEN
    RAISE EXCEPTION 'Only the current owner can transfer ownership.' USING ERRCODE = '42501';
  END IF;

  IF p_to_user_id = v_actor THEN
    RAISE EXCEPTION 'You are already the owner.' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.organization_id = p_organization_id
       AND ur.user_id = p_to_user_id
       AND ur.is_active = true
       AND ur.user_type = 'internal'
  ) THEN
    RAISE EXCEPTION 'The recipient must be an active internal member of this organization.'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.organization_ownership_transfers
     SET status = 'expired', responded_at = now()
   WHERE organization_id = p_organization_id
     AND status = 'pending'
     AND expires_at <= now();

  INSERT INTO public.organization_ownership_transfers (
    organization_id, from_user_id, to_user_id, note
  ) VALUES (p_organization_id, v_actor, p_to_user_id, p_note)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    organization_id, user_id, action, entity_type, entity_id, new_values, changes_summary
  ) VALUES (
    p_organization_id, v_actor, 'ownership_transfer_proposed',
    'organization_ownership_transfer', v_id,
    jsonb_build_object('to_user_id', p_to_user_id, 'note', p_note),
    'Ownership transfer proposed'
  );

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.propose_ownership_transfer(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_ownership_transfer(uuid, uuid, text) TO authenticated;
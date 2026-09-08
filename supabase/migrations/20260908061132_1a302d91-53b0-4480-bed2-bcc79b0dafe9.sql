CREATE OR REPLACE FUNCTION public.accept_ownership_transfer(p_transfer_id uuid)
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

  IF v_t.to_user_id <> v_actor THEN
    RAISE EXCEPTION 'Only the nominated recipient can accept this transfer.' USING ERRCODE = '42501';
  END IF;

  IF v_t.status <> 'pending' THEN
    RAISE EXCEPTION 'This transfer is no longer pending.' USING ERRCODE = '22023';
  END IF;

  IF v_t.expires_at <= now() THEN
    UPDATE public.organization_ownership_transfers
       SET status = 'expired', responded_at = now()
     WHERE id = p_transfer_id;
    RAISE EXCEPTION 'This transfer has expired.' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.id = v_t.organization_id AND o.owner_user_id = v_t.from_user_id
  ) THEN
    RAISE EXCEPTION 'The proposing owner is no longer the owner.' USING ERRCODE = '22023';
  END IF;

  -- The organizations trigger steps the outgoing owner down and promotes the
  -- recipient's membership row.
  UPDATE public.organizations
     SET owner_user_id = v_t.to_user_id
   WHERE id = v_t.organization_id;

  UPDATE public.organization_ownership_transfers
     SET status = 'accepted', responded_at = now()
   WHERE id = p_transfer_id;

  INSERT INTO public.audit_logs (
    organization_id, user_id, action, entity_type, entity_id,
    old_values, new_values, changes_summary
  ) VALUES (
    v_t.organization_id, v_actor, 'ownership_transfer_accepted',
    'organization_ownership_transfer', p_transfer_id,
    jsonb_build_object('owner_user_id', v_t.from_user_id),
    jsonb_build_object('owner_user_id', v_t.to_user_id),
    'Ownership transfer accepted'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.accept_ownership_transfer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_ownership_transfer(uuid) TO authenticated;
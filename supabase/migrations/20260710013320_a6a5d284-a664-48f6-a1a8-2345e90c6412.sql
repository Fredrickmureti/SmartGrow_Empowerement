-- Fix scrap SoD guard: correct argument order/types on governance_assert_not_self,
-- and stop pre-seeding a hard block for solo orgs (which have no possible cosigner).

CREATE OR REPLACE FUNCTION public.sod_stock_adjustment_scrap_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.adjustment_type IS DISTINCT FROM 'scrap' THEN
    RETURN NEW;
  END IF;

  -- Only enforce on the transition into an approved/posted state.
  IF NEW.status IN ('approved','posted')
     AND (OLD.status IS DISTINCT FROM NEW.status)
     AND NEW.approved_by IS NOT NULL
     AND NEW.created_by IS NOT NULL THEN
    PERFORM public.governance_assert_not_self(
      NEW.approved_by,        -- p_actor
      NEW.created_by,         -- p_subject
      'scrap.approve',        -- p_action
      NEW.organization_id,    -- p_org
      'stock_adjustment',     -- p_entity_type
      NEW.id                  -- p_entity_id
    );
  END IF;

  RETURN NEW;
END;
$function$;

-- Remove pre-seeded hard-block scrap.approve policies for solo orgs: with only
-- one active member, a hard block is unreachable and there is no cosigner to
-- request. Governance_assert_not_self already auto-allows solo orgs when no
-- explicit policy row exists.
DELETE FROM public.self_action_policy sap
 WHERE sap.action_key = 'scrap.approve'
   AND sap.mode = 'block'
   AND sap.applies_to_role IS NULL
   AND (
     SELECT count(DISTINCT ur.user_id)
       FROM public.user_roles ur
      WHERE ur.organization_id = sap.organization_id
        AND ur.is_active = true
   ) <= 1;
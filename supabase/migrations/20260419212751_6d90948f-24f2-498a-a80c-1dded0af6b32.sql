-- Defensive backfill (idempotent)
INSERT INTO public.user_business_access (user_id, organization_id, business_id, is_primary, can_switch)
SELECT DISTINCT
  ur.user_id, b.organization_id, b.id, true, true
FROM public.user_roles ur
JOIN public.businesses b ON b.organization_id = ur.organization_id
WHERE ur.role::text IN ('owner', 'admin', 'super_admin')
  AND b.is_active = true
  AND NOT EXISTS (
    SELECT 1 FROM public.user_business_access uba
    WHERE uba.user_id = ur.user_id AND uba.business_id = b.id
  )
ON CONFLICT DO NOTHING;

-- Null out user references in tables that don't cascade
UPDATE public.demo_requests SET contacted_by = NULL WHERE contacted_by IS NOT NULL;

-- Wipe all auth users (Pre-launch reset — re-signup required)
DELETE FROM auth.users;
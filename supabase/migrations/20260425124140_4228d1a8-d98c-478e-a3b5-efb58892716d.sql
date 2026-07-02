-- Clean up orphaned system permission groups left over from deleted organizations.
-- Their associated rule rows will cascade-delete via permission_group_rules FK.
DELETE FROM public.permission_groups
WHERE NOT EXISTS (
  SELECT 1 FROM public.organizations o WHERE o.id = permission_groups.organization_id
);

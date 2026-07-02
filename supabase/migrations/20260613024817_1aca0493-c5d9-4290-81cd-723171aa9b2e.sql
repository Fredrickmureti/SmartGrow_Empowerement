-- Remove placeholder employer statutory identifiers seeded by a prior migration.
-- Odoo-style: the system never invents values for the tenant; the field is left
-- blank and the admin fills it in. Only rows still holding the sentinel values
-- are deleted, so any real value the admin already typed is preserved.
DELETE FROM public.organization_statutory_identifiers
WHERE identifier_value ~* '(^P000000000X$|PENDING|placeholder)';
-- No branch has ever set any of these (branch_setting_overrides is empty), so
-- this is a whitelist-only prune with no data migration.
--
-- ROLLBACK (re-seed) — uncomment to restore:
-- INSERT INTO public.branch_overridable_settings (setting_key, display_name, description, value_type, category)
-- VALUES ('invoice_prefix','Invoice number prefix',NULL,'text','documents'),
--        ('estimate_prefix','Estimate number prefix',NULL,'text','documents'),
--        ('bill_prefix','Bill number prefix',NULL,'text','documents'),
--        ('receipt_prefix','POS receipt prefix',NULL,'text','documents');
DELETE FROM public.branch_overridable_settings
WHERE setting_key IN ('invoice_prefix', 'estimate_prefix', 'bill_prefix', 'receipt_prefix');
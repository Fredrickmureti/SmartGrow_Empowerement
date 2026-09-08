UPDATE public.accounts
SET is_active = false, updated_at = now()
WHERE is_active = true
  AND code IN ('1130','1320','1330','21100','2210-SYS','4010','4210-SYS','4910','4910-SYS','4930','5100','5150','5160','5910','5920','6910-SYS')
  AND NOT EXISTS (SELECT 1 FROM public.journal_entry_lines l WHERE l.account_id = accounts.id)
  AND NOT EXISTS (SELECT 1 FROM public.mf_account_mappings m WHERE m.account_id = accounts.id);

-- Rollback:
-- UPDATE public.accounts SET is_active = true
-- WHERE code IN ('1130','1320','1330','21100','2210-SYS','4010','4210-SYS','4910','4910-SYS','4930','5100','5150','5160','5910','5920','6910-SYS');

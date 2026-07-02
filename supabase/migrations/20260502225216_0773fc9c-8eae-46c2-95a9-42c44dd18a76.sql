UPDATE public.platform_settings t
SET setting_value = s.setting_value
FROM public.platform_settings s
WHERE t.setting_key = 'support_reply_to_email'
  AND (t.setting_value IS NULL OR t.setting_value = '')
  AND s.setting_key = 'resend_reply_to_email'
  AND s.setting_value IS NOT NULL
  AND s.setting_value <> '';
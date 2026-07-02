UPDATE public.notifications
SET link = CASE
  WHEN entity_type = 'invoice' AND entity_id IS NOT NULL
    THEN '/sales/invoices?id=' || entity_id::text
  ELSE '/sales/invoices'
END
WHERE link = '/invoices';
UPDATE notifications
   SET created_at = now() - interval '2 hours'
 WHERE entity_type IN ('out_of_stock','critical_stock','low_stock')
   AND created_at > now() - interval '2 hours';
BEGIN;
SELECT set_config('request.jwt.claim.sub', 'af903a2e-3ab0-43f5-b2f0-1a4000985084', true);
SELECT public.confirm_invoice_and_release_stock_atomic(
  '8a5d6ae5-764c-41d5-855e-28c0924d0411'::uuid,
  'af903a2e-3ab0-43f5-b2f0-1a4000985084'::uuid,
  '[{"account_id":"a7cc58f6-03fb-4526-974e-0ebe29d94ffa","debit":50,"credit":0,"description":"Invoice INV-00010 - Accounts Receivable","contact_id":"54709d33-f976-4c42-8f2e-f27cca6a85fd"},{"account_id":"d31cf8e8-8613-466b-be3f-615ed97e7885","debit":0,"credit":50,"description":"Invoice INV-00010 - Sales Revenue"}]'::jsonb,
  true,
  NULL::uuid
);
ROLLBACK;
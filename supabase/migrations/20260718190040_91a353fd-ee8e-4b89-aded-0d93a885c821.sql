
-- T7 governance follow-up: register POS duties
INSERT INTO public.governance_duties (duty_code, label, domain, description) VALUES
  ('pos.commit',           'Commit POS sale',        'pos', 'Finalize a POS transaction (sale / return / exchange).'),
  ('pos.void',             'Void POS transaction',   'pos', 'Void a completed POS transaction and reverse its ledger impact.'),
  ('pos.return',           'Process POS return',     'pos', 'Accept a customer return against a prior POS sale.'),
  ('pos.override_price',   'Override POS price',     'pos', 'Override the catalog unit price on a POS line at commit time.'),
  ('pos.override_discount','Override POS discount',  'pos', 'Apply a manual line- or transaction-level discount beyond configured rules.')
ON CONFLICT (duty_code) DO UPDATE
  SET label = EXCLUDED.label,
      domain = EXCLUDED.domain,
      description = EXCLUDED.description;

INSERT INTO public.governance_duty_permission_map (duty_code, module, operation) VALUES
  ('pos.commit',           'pos', 'commit'),
  ('pos.void',             'pos', 'void'),
  ('pos.return',           'pos', 'return'),
  ('pos.override_price',   'pos', 'override_price'),
  ('pos.override_discount','pos', 'override_discount')
ON CONFLICT DO NOTHING;

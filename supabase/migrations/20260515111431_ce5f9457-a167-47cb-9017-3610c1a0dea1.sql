
ALTER TABLE public.pack_versions
  ADD COLUMN IF NOT EXISTS parent_version_id uuid REFERENCES public.pack_versions(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pack_versions_pack_version_unique') THEN
    ALTER TABLE public.pack_versions ADD CONSTRAINT pack_versions_pack_version_unique UNIQUE (pack_id, version);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pack_versions_pack_status_idx ON public.pack_versions (pack_id, status);

INSERT INTO public.pack_rule_type_schemas (rule_type, computation_kind, schema_version, json_schema, ui_schema, token_outputs, description) VALUES
  ('income_tax','graduated',1,
   '{"type":"object","required":["bands"],"properties":{"bands":{"type":"array","minItems":1,"items":{"type":"object","required":["upper","rate"],"properties":{"lower":{"type":"number","minimum":0},"upper":{"type":["number","null"]},"rate":{"type":"number","minimum":0,"maximum":1}}}}}}'::jsonb,
   '{"bands":{"ui:widget":"BandsWidget"}}'::jsonb,
   '["run.paye","run.taxable_pay"]'::jsonb,
   'Graduated income tax bands (PAYE, IRPP, IRPF).'),
  ('statutory_deduction','flat',1,
   '{"type":"object","required":["rate"],"properties":{"rate":{"type":"number","minimum":0,"maximum":1},"applies_to":{"type":"string","enum":["gross","basic","taxable"],"default":"gross"},"cap":{"type":["number","null"],"minimum":0}}}'::jsonb,
   NULL,'["run.total_deductions"]'::jsonb,
   'Flat-rate statutory deduction with optional cap and base.'),
  ('statutory_deduction','fixed',1,
   '{"type":"object","required":["amount"],"properties":{"amount":{"type":"number","minimum":0},"frequency":{"type":"string","enum":["monthly","annual"],"default":"monthly"}}}'::jsonb,
   NULL,'["run.paye"]'::jsonb,
   'Fixed-amount relief or credit (personal relief, insurance relief).'),
  ('employer_contribution','percentage',1,
   '{"type":"object","required":["rate"],"properties":{"rate":{"type":"number","minimum":0,"maximum":1},"applies_to":{"type":"string","enum":["gross","basic","headcount"],"default":"gross"},"cap":{"type":["number","null"],"minimum":0}}}'::jsonb,
   NULL,'["run.total_employer_cost"]'::jsonb,
   'Percentage-based employer-only contribution.'),
  ('statutory_deduction','tiered_employer_employee',1,
   '{"type":"object","required":["tiers"],"properties":{"tiers":{"type":"array","minItems":1,"items":{"type":"object","required":["upper","employee_rate","employer_rate"],"properties":{"lower":{"type":"number","minimum":0},"upper":{"type":["number","null"]},"employee_rate":{"type":"number","minimum":0,"maximum":1},"employer_rate":{"type":"number","minimum":0,"maximum":1}}}}}}'::jsonb,
   NULL,'["run.total_deductions","run.total_employer_cost"]'::jsonb,
   'Tiered contributions with separate employer + employee rates per band.'),
  ('statutory_deduction','pension',1,
   '{"type":"object","required":["employee_rate","employer_rate"],"properties":{"employee_rate":{"type":"number","minimum":0,"maximum":1},"employer_rate":{"type":"number","minimum":0,"maximum":1},"applies_to":{"type":"string","enum":["gross","basic","pensionable"],"default":"pensionable"},"cap":{"type":["number","null"],"minimum":0}}}'::jsonb,
   NULL,'["run.total_deductions","run.total_employer_cost"]'::jsonb,
   'Pension / provident-fund split between employee and employer.'),
  ('statutory_deduction','per_head',1,
   '{"type":"object","required":["amount"],"properties":{"amount":{"type":"number","minimum":0}}}'::jsonb,
   NULL,'["run.total_deductions"]'::jsonb,
   'Per-employee flat deduction (union dues, association fees).'),
  ('statutory_deduction','percentage_with_floor',1,
   '{"type":"object","required":["rate"],"properties":{"rate":{"type":"number","minimum":0,"maximum":1},"floor":{"type":"number","minimum":0,"default":0},"applies_to":{"type":"string","enum":["gross","basic","taxable"],"default":"gross"}}}'::jsonb,
   NULL,'["run.total_deductions"]'::jsonb,
   'Percentage deduction with a minimum-amount floor (SHIF, NHIF v2).')
ON CONFLICT DO NOTHING;

INSERT INTO public.pack_token_registry (token_path, source, data_type, sample_value, description) VALUES
  ('run.basic_pay','run','currency','50000'::jsonb,'Period basic salary.'),
  ('run.allowances_total','run','currency','12000'::jsonb,'Sum of allowances.'),
  ('run.benefits_total','run','currency','5000'::jsonb,'Sum of non-cash benefits.'),
  ('run.paye','run','currency','8500'::jsonb,'PAYE for the period.'),
  ('run.relief_total','run','currency','2400'::jsonb,'Sum of personal/insurance/mortgage relief.'),
  ('run.employer_contributions_total','run','currency','7000'::jsonb,'Sum of employer-side statutory contributions.'),
  ('run.period_label','run','string','"May 2026"'::jsonb,'Human-readable period label.'),
  ('run.payroll_run_id','run','string','"prr_…"'::jsonb,'Payroll run id.'),
  ('employee.first_name','employee','string','"Jane"'::jsonb,'Employee first name.'),
  ('employee.last_name','employee','string','"Doe"'::jsonb,'Employee last name.'),
  ('employee.nssf_number','employee','string','"NSSF1234"'::jsonb,'Employee social-security number.'),
  ('employee.shif_number','employee','string','"SHIF…"'::jsonb,'Employee health-insurance number.'),
  ('employee.email','employee','string','"jane@acme.co"'::jsonb,'Employee email.'),
  ('employee.hire_date','employee','date','"2024-01-15"'::jsonb,'Employee hire date.'),
  ('contract.allowances','contract','string','{"housing":15000,"transport":5000}'::jsonb,'Per-allowance contract map.'),
  ('contract.payment_frequency','contract','string','"monthly"'::jsonb,'Pay cycle.'),
  ('contract.currency','contract','string','"KES"'::jsonb,'Contract currency code.'),
  ('organization.address','system','string','"PO Box 1, Nairobi"'::jsonb,'Organization mailing address.'),
  ('organization.phone','system','string','"+254700000000"'::jsonb,'Organization phone.'),
  ('organization.country_code','system','string','"KE"'::jsonb,'Organization ISO-2 country code.'),
  ('system.now','system','date','"2026-05-15"'::jsonb,'Document generation timestamp.'),
  ('system.tax_year','system','string','"2026"'::jsonb,'Active tax year.')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.tg_pack_audit_log_writer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pack_id uuid; v_org_id uuid; v_actor uuid := auth.uid();
  v_action text := lower(TG_OP); v_before jsonb; v_after jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_before := to_jsonb(OLD); v_after := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    v_before := to_jsonb(OLD); v_after := to_jsonb(NEW);
    IF v_before = v_after THEN RETURN NEW; END IF;
  ELSE
    v_before := NULL; v_after := to_jsonb(NEW);
  END IF;
  v_pack_id := COALESCE((v_after->>'pack_id')::uuid, (v_before->>'pack_id')::uuid);
  v_org_id  := COALESCE((v_after->>'organization_id')::uuid, (v_before->>'organization_id')::uuid);
  INSERT INTO public.pack_audit_log
    (pack_id, organization_id, actor_id, scope, entity_table, entity_id, action, before, after)
  VALUES
    (v_pack_id, v_org_id, v_actor,
     CASE WHEN v_org_id IS NULL THEN 'admin' ELSE 'tenant' END,
     TG_TABLE_NAME,
     COALESCE((v_after->>'id')::uuid, (v_before->>'id')::uuid),
     v_action, v_before, v_after);
  RETURN COALESCE(NEW, OLD);
END $$;

DO $$
DECLARE t text;
  tables text[] := ARRAY[
    'pack_versions','localization_pack_payroll_templates','localization_pack_account_templates',
    'localization_pack_tax_templates','localization_pack_certificate_templates',
    'localization_pack_return_templates','localization_pack_remittance_schedules','payroll_statutory_rules'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_pack_audit_log_writer ON public.%I;
       CREATE TRIGGER trg_pack_audit_log_writer AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.tg_pack_audit_log_writer();', t, t);
  END LOOP;
END $$;

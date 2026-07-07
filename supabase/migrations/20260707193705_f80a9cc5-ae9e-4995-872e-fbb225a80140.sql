
-- Gap #1: register three new income-tax computation schemas so
-- localization packs can author them under the ADR-0010 validator.

INSERT INTO public.pack_rule_type_schemas
  (rule_type, computation_kind, schema_version, json_schema, ui_schema, token_outputs, description)
VALUES
-- ─── income_tax / flat ───────────────────────────────────────────────
(
  'income_tax', 'flat', 1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Flat-rate income tax',
    'type', 'object',
    'required', jsonb_build_array('type', 'rate_percent'),
    'additionalProperties', false,
    'properties', jsonb_build_object(
      'type',          jsonb_build_object('const', 'flat'),
      'rate_percent',  jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 100,
                       'description', 'Single tax rate applied to the whole base, in percent (25 = 25%).'),
      'base_code',     jsonb_build_object('type', 'string',
                       'description', 'Token identifying the taxable base. Defaults to taxable_income.'),
      'min_taxable',   jsonb_build_object('type', 'number', 'minimum', 0,
                       'description', 'Optional exemption threshold below which no tax applies.'),
      'residency',     jsonb_build_object('type', 'string', 'enum', jsonb_build_array('resident', 'non_resident', 'any'),
                       'description', 'Which residency branch this rule applies to. Engine filters by employees.residency_status.')
    )
  ),
  jsonb_build_object(
    'ui:order', jsonb_build_array('rate_percent', 'residency', 'base_code', 'min_taxable', 'type')
  ),
  jsonb_build_array('income_tax'),
  'Flat-rate income tax (e.g. non-resident PAYE, expat withholding). Applies one rate to the whole taxable base.'
),

-- ─── income_tax / bonus_windfall ─────────────────────────────────────
(
  'income_tax', 'bonus_windfall', 1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Bonus / 13th-cheque concessional tax',
    'type', 'object',
    'required', jsonb_build_array('type', 'flat_rate_percent', 'input_code'),
    'additionalProperties', false,
    'properties', jsonb_build_object(
      'type',                          jsonb_build_object('const', 'bonus_windfall'),
      'flat_rate_percent',             jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 100,
                                       'description', 'Concessional flat rate for the qualifying portion of bonus (Ghana: 5%).'),
      'threshold_pct_of_annual_basic', jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 100,
                                       'description', 'Cap on the qualifying portion, expressed as a % of the employee''s annual basic (Ghana: 15).'),
      'excess_treatment',              jsonb_build_object('type', 'string',
                                       'enum', jsonb_build_array('roll_to_paye', 'ignore'),
                                       'default', 'roll_to_paye',
                                       'description', 'What to do with bonus above the threshold: roll into ordinary PAYE, or ignore for this rule.'),
      'input_code',                    jsonb_build_object('type', 'string',
                                       'description', 'Registered employee-input token supplying the bonus amount (e.g. bonus_amount).'),
      'annual_basic_token',            jsonb_build_object('type', 'string',
                                       'description', 'Token resolving to annual basic salary. Defaults to basic_salary * 12.')
    )
  ),
  jsonb_build_object(
    'ui:order', jsonb_build_array('flat_rate_percent', 'threshold_pct_of_annual_basic',
                                  'excess_treatment', 'input_code', 'annual_basic_token', 'type')
  ),
  jsonb_build_array('income_tax', 'bonus_tax', 'bonus_rolled_to_paye'),
  'Concessional bonus / 13th-cheque tax: flat rate up to a threshold %% of annual basic, excess rolled to PAYE.'
),

-- ─── income_tax / overtime_concessional ──────────────────────────────
(
  'income_tax', 'overtime_concessional', 1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Concessional overtime tax',
    'type', 'object',
    'required', jsonb_build_array('type', 'flat_rate_percent', 'monthly_cash_cap', 'input_code'),
    'additionalProperties', false,
    'properties', jsonb_build_object(
      'type',                     jsonb_build_object('const', 'overtime_concessional'),
      'flat_rate_percent',        jsonb_build_object('type', 'number', 'minimum', 0, 'maximum', 100,
                                  'description', 'Concessional rate on qualifying overtime (Ghana QJE: 5%).'),
      'monthly_cash_cap',         jsonb_build_object('type', 'number', 'minimum', 0,
                                  'description', 'Monthly cash cap of qualifying overtime in pack currency (Ghana: 18000).'),
      'qualifying_junior_only',   jsonb_build_object('type', 'boolean', 'default', true,
                                  'description', 'If true, only employees flagged as qualifying junior employees are eligible.'),
      'input_code',               jsonb_build_object('type', 'string',
                                  'description', 'Registered employee-input token supplying overtime cash (e.g. overtime_amount).'),
      'excess_treatment',         jsonb_build_object('type', 'string',
                                  'enum', jsonb_build_array('roll_to_paye', 'ignore'),
                                  'default', 'roll_to_paye')
    )
  ),
  jsonb_build_object(
    'ui:order', jsonb_build_array('flat_rate_percent', 'monthly_cash_cap',
                                  'qualifying_junior_only', 'input_code', 'excess_treatment', 'type')
  ),
  jsonb_build_array('income_tax', 'overtime_tax', 'overtime_rolled_to_paye'),
  'Concessional overtime tax: flat rate up to a monthly cash cap, excess rolled to PAYE.'
)
ON CONFLICT DO NOTHING;

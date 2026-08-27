DO $mig$
DECLARE
  v_org        uuid := '8e682296-c634-44c8-ae00-bc48940ec28b';
  v_parent     uuid := 'bf392ca6-a743-435c-ae41-5bf25199470d';
  v_sub        uuid;
  v_group      uuid;
  v_cta        uuid;
  -- parent accounts
  v_p_ic_ar    uuid;
  v_p_ic_inc   uuid;
  -- subsidiary accounts
  v_s_cash     uuid;
  v_s_ic_ap    uuid;
  v_s_cap      uuid;
  v_s_rev      uuid;
  v_s_ic_exp   uuid;
  -- contacts
  v_c_parent_side uuid;  -- contact in parent books representing the subsidiary
  v_c_sub_side    uuid;  -- contact in subsidiary books representing the parent
  v_je         uuid;
  v_ga         record;
BEGIN
  SELECT id INTO v_group FROM public.consolidation_groups WHERE organization_id = v_org ORDER BY created_at LIMIT 1;
  IF v_group IS NULL THEN
    RAISE EXCEPTION 'No consolidation group exists in this organization; nothing to seed against';
  END IF;

  ------------------------------------------------------------------
  -- 1. Subsidiary company (USD books)
  ------------------------------------------------------------------
  SELECT id INTO v_sub FROM public.businesses
   WHERE organization_id = v_org AND name = 'Mombasa Port Services';

  IF v_sub IS NULL THEN
    INSERT INTO public.businesses (organization_id, name, legal_name, country, base_currency,
                                   fiscal_year_start, tax_id, registration_number, city, is_active)
    VALUES (v_org, 'Mombasa Port Services', 'Mombasa Port Services Limited', 'KE', 'USD',
            1, 'P052001234X', 'PVT-MPS-2026', 'Mombasa', true)
    RETURNING id INTO v_sub;
  END IF;

  ------------------------------------------------------------------
  -- 2. Exchange rates: USD -> KES, monthly, covering Jan..Jul 2026
  ------------------------------------------------------------------
  INSERT INTO public.exchange_rates (organization_id, business_id, from_currency, to_currency,
                                     rate, effective_date, source, published_at)
  SELECT v_org, v_parent, 'USD', 'KES', r.rate, r.d, 'manual', now()
    FROM (VALUES
      (126.00, DATE '2026-01-01'),
      (127.00, DATE '2026-02-01'),
      (128.00, DATE '2026-03-01'),
      (129.00, DATE '2026-04-01'),
      (130.00, DATE '2026-05-01'),
      (131.00, DATE '2026-06-01'),
      (131.50, DATE '2026-06-30'),
      (132.00, DATE '2026-07-01'),
      (133.00, DATE '2026-07-31')
    ) AS r(rate, d)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.exchange_rates e
      WHERE e.organization_id = v_org AND e.business_id = v_parent
        AND e.from_currency = 'USD' AND e.to_currency = 'KES'
        AND e.effective_date = r.d
   );

  ------------------------------------------------------------------
  -- 3. Parent intercompany accounts
  ------------------------------------------------------------------
  SELECT id INTO v_p_ic_ar FROM public.accounts WHERE business_id = v_parent AND code = '1180';
  IF v_p_ic_ar IS NULL THEN
    INSERT INTO public.accounts (organization_id, business_id, code, name, account_type, detail_type, is_active)
    VALUES (v_org, v_parent, '1180', 'Intercompany receivable - Mombasa Port Services', 'asset', 'other_current_asset', true)
    RETURNING id INTO v_p_ic_ar;
  END IF;

  SELECT id INTO v_p_ic_inc FROM public.accounts WHERE business_id = v_parent AND code = '4180';
  IF v_p_ic_inc IS NULL THEN
    INSERT INTO public.accounts (organization_id, business_id, code, name, account_type, detail_type, is_active)
    VALUES (v_org, v_parent, '4180', 'Intercompany management fees', 'income', 'other_business_income', true)
    RETURNING id INTO v_p_ic_inc;
  END IF;

  ------------------------------------------------------------------
  -- 4. Subsidiary chart (deliberately different codes)
  ------------------------------------------------------------------
  INSERT INTO public.accounts (organization_id, business_id, code, name, account_type, detail_type, is_active)
  SELECT v_org, v_sub, c.code, c.name, c.atype::public.account_type, c.dtype, true
    FROM (VALUES
      ('1010', 'Cash at bank', 'asset', 'checking'),
      ('2180', 'Intercompany payable - Joshua Holdings', 'liability', 'other_current_liabilities'),
      ('3100', 'Share capital', 'equity', 'common_stock'),
      ('4100', 'Port service revenue', 'income', 'service_income'),
      ('5180', 'Intercompany management fees', 'expense', 'other_business_expenses')
    ) AS c(code, name, atype, dtype)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.accounts a WHERE a.business_id = v_sub AND a.code = c.code
   );

  SELECT id INTO v_s_cash   FROM public.accounts WHERE business_id = v_sub AND code = '1010';
  SELECT id INTO v_s_ic_ap  FROM public.accounts WHERE business_id = v_sub AND code = '2180';
  SELECT id INTO v_s_cap    FROM public.accounts WHERE business_id = v_sub AND code = '3100';
  SELECT id INTO v_s_rev    FROM public.accounts WHERE business_id = v_sub AND code = '4100';
  SELECT id INTO v_s_ic_exp FROM public.accounts WHERE business_id = v_sub AND code = '5180';

  ------------------------------------------------------------------
  -- 5. Group: translation reserve + subsidiary member
  ------------------------------------------------------------------
  SELECT id INTO v_cta FROM public.accounts WHERE business_id = v_parent AND code = '3050';
  IF v_cta IS NOT NULL THEN
    UPDATE public.consolidation_groups SET cta_account_id = v_cta
     WHERE id = v_group AND cta_account_id IS DISTINCT FROM v_cta;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.consolidation_group_members m
     WHERE m.group_id = v_group AND m.business_id = v_sub
  ) THEN
    INSERT INTO public.consolidation_group_members
      (organization_id, group_id, business_id, parent_business_id, ownership_percent,
       method, effective_from, historical_rate_date, notes)
    VALUES (v_org, v_group, v_sub, v_parent, 100, 'full', DATE '2026-01-01', DATE '2026-05-01',
            'Multi-member walkthrough fixture');
  END IF;

  ------------------------------------------------------------------
  -- 6. Group chart
  ------------------------------------------------------------------
  INSERT INTO public.consolidation_group_accounts
    (organization_id, group_id, code, name, account_type, sort_order, is_active)
  SELECT v_org, v_group, g.code, g.name, g.atype::public.account_type, g.ord, true
    FROM (VALUES
      ('G1100', 'Intercompany receivables', 'asset', 10),
      ('G1900', 'Other assets', 'asset', 20),
      ('G2100', 'Intercompany payables', 'liability', 30),
      ('G2900', 'Other liabilities', 'liability', 40),
      ('G3900', 'Equity', 'equity', 50),
      ('G4900', 'Income', 'income', 60),
      ('G5900', 'Expenses', 'expense', 70)
    ) AS g(code, name, atype, ord)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.consolidation_group_accounts ga
      WHERE ga.group_id = v_group AND ga.code = g.code
   );

  -- Explicit intercompany mappings first.
  FOR v_ga IN
    SELECT * FROM (VALUES
      (v_parent, v_p_ic_ar, 'G1100'),
      (v_sub,    v_s_ic_ap, 'G2100')
    ) AS t(biz, acct, gcode)
  LOOP
    IF v_ga.acct IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.consolidation_account_mappings m
       WHERE m.group_id = v_group AND m.business_id = v_ga.biz AND m.account_id = v_ga.acct
    ) THEN
      INSERT INTO public.consolidation_account_mappings
        (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
      SELECT v_org, v_group, v_ga.biz, v_ga.acct, ga.id, DATE '2026-01-01'
        FROM public.consolidation_group_accounts ga
       WHERE ga.group_id = v_group AND ga.code = v_ga.gcode;
    END IF;
  END LOOP;

  -- Everything else falls to its account type's group line. The group's
  -- translation reserve is deliberately excluded: it is presented on its own.
  INSERT INTO public.consolidation_account_mappings
    (organization_id, group_id, business_id, account_id, group_account_id, effective_from)
  SELECT v_org, v_group, a.business_id, a.id, ga.id, DATE '2026-01-01'
    FROM public.accounts a
    JOIN public.consolidation_group_accounts ga
      ON ga.group_id = v_group
     AND ga.code = CASE a.account_type::text
                     WHEN 'asset' THEN 'G1900'
                     WHEN 'liability' THEN 'G2900'
                     WHEN 'equity' THEN 'G3900'
                     WHEN 'income' THEN 'G4900'
                     ELSE 'G5900'
                   END
   WHERE a.business_id IN (v_parent, v_sub)
     AND COALESCE(a.is_active, true)
     AND NOT COALESCE(a.is_header, false)
     AND a.id IS DISTINCT FROM v_cta
     AND NOT EXISTS (
       SELECT 1 FROM public.consolidation_account_mappings m
        WHERE m.group_id = v_group AND m.business_id = a.business_id AND m.account_id = a.id
     );

  ------------------------------------------------------------------
  -- 7. Intercompany counterparty links
  ------------------------------------------------------------------
  SELECT id INTO v_c_parent_side FROM public.contacts
   WHERE business_id = v_parent AND name = 'Mombasa Port Services (intercompany)';
  IF v_c_parent_side IS NULL THEN
    INSERT INTO public.contacts (organization_id, business_id, name, tax_id, customer_rank,
                                 is_company, default_currency, is_active)
    VALUES (v_org, v_parent, 'Mombasa Port Services (intercompany)', 'P052001234X', 1,
            true, 'USD', true)
    RETURNING id INTO v_c_parent_side;
  END IF;

  SELECT id INTO v_c_sub_side FROM public.contacts
   WHERE business_id = v_sub AND name = 'Joshua Holdings (intercompany)';
  IF v_c_sub_side IS NULL THEN
    INSERT INTO public.contacts (organization_id, business_id, name, tax_id, supplier_rank,
                                 is_company, default_currency, is_active)
    SELECT v_org, v_sub, 'Joshua Holdings (intercompany)', b.tax_id, 1, true, 'KES', true
      FROM public.businesses b WHERE b.id = v_parent
    RETURNING id INTO v_c_sub_side;
  END IF;

  INSERT INTO public.consolidation_intercompany_partners
    (organization_id, group_id, business_id, contact_id, counterparty_business_id, effective_from, notes)
  SELECT v_org, v_group, p.biz, p.contact, p.counter, DATE '2026-01-01', 'Multi-member walkthrough fixture'
    FROM (VALUES
      (v_parent, v_c_parent_side, v_sub),
      (v_sub,    v_c_sub_side,    v_parent)
    ) AS p(biz, contact, counter)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.consolidation_intercompany_partners x
      WHERE x.group_id = v_group AND x.business_id = p.biz AND x.contact_id = p.contact
   );

  ------------------------------------------------------------------
  -- 8. Journal entries
  ------------------------------------------------------------------
  -- 8a. Subsidiary opening capital (USD 500,000) on 1 May 2026
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE business_id = v_sub AND entry_number = 'MPS-OPEN-2026-001') THEN
    INSERT INTO public.journal_entries (organization_id, business_id, entry_number, entry_date, description,
                                        status, posted_at, currency, exchange_rate, total_debit, total_credit)
    VALUES (v_org, v_sub, 'MPS-OPEN-2026-001', DATE '2026-05-01', 'Opening share capital',
            'posted', now(), 'USD', 1, 500000, 500000)
    RETURNING id INTO v_je;

    INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id,
                                            description, debit, credit, original_currency, exchange_rate, sort_order)
    VALUES (v_org, v_sub, v_je, v_s_cash, 'Capital received', 500000, 0, 'USD', 1, 1),
           (v_org, v_sub, v_je, v_s_cap,  'Share capital', 0, 500000, 'USD', 1, 2);
  END IF;

  -- 8b. Subsidiary port revenue (USD 80,000) on 15 July 2026
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE business_id = v_sub AND entry_number = 'MPS-REV-2026-001') THEN
    INSERT INTO public.journal_entries (organization_id, business_id, entry_number, entry_date, description,
                                        status, posted_at, currency, exchange_rate, total_debit, total_credit)
    VALUES (v_org, v_sub, 'MPS-REV-2026-001', DATE '2026-07-15', 'Port services billed and collected',
            'posted', now(), 'USD', 1, 80000, 80000)
    RETURNING id INTO v_je;

    INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id,
                                            description, debit, credit, original_currency, exchange_rate, sort_order)
    VALUES (v_org, v_sub, v_je, v_s_cash, 'Cash received', 80000, 0, 'USD', 1, 1),
           (v_org, v_sub, v_je, v_s_rev,  'Port service revenue', 0, 80000, 'USD', 1, 2);
  END IF;

  -- 8c. Intercompany management fee recharge, 30 June 2026.
  --     Parent books KES 2,630,000 (USD 20,000 at 131.50); subsidiary books USD 20,000.
  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE business_id = v_parent AND entry_number = 'JH-IC-2026-001') THEN
    INSERT INTO public.journal_entries (organization_id, business_id, entry_number, entry_date, description,
                                        status, posted_at, currency, exchange_rate, total_debit, total_credit)
    VALUES (v_org, v_parent, 'JH-IC-2026-001', DATE '2026-06-30',
            'Management fee recharged to Mombasa Port Services',
            'posted', now(), 'KES', 1, 2630000, 2630000)
    RETURNING id INTO v_je;

    INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id,
                                            description, debit, credit, contact_id,
                                            original_currency, original_debit, original_credit, exchange_rate, sort_order)
    VALUES (v_org, v_parent, v_je, v_p_ic_ar,  'Recharge receivable', 2630000, 0, v_c_parent_side,
            'USD', 20000, 0, 131.50, 1),
           (v_org, v_parent, v_je, v_p_ic_inc, 'Management fee income', 0, 2630000, v_c_parent_side,
            'USD', 0, 20000, 131.50, 2);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.journal_entries WHERE business_id = v_sub AND entry_number = 'MPS-IC-2026-001') THEN
    INSERT INTO public.journal_entries (organization_id, business_id, entry_number, entry_date, description,
                                        status, posted_at, currency, exchange_rate, total_debit, total_credit)
    VALUES (v_org, v_sub, 'MPS-IC-2026-001', DATE '2026-06-30',
            'Management fee charged by Joshua Holdings',
            'posted', now(), 'USD', 1, 20000, 20000)
    RETURNING id INTO v_je;

    INSERT INTO public.journal_entry_lines (organization_id, business_id, journal_entry_id, account_id,
                                            description, debit, credit, contact_id,
                                            original_currency, exchange_rate, sort_order)
    VALUES (v_org, v_sub, v_je, v_s_ic_exp, 'Management fee expense', 20000, 0, v_c_sub_side, 'USD', 1, 1),
           (v_org, v_sub, v_je, v_s_ic_ap,  'Owed to Joshua Holdings', 0, 20000, v_c_sub_side, 'USD', 1, 2);
  END IF;

  RAISE NOTICE 'Seed complete: group %, subsidiary %', v_group, v_sub;
END $mig$;
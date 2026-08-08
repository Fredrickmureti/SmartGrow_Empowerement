-- Regression: every non-payroll system account role that has a chart template
-- MUST resolve to a concrete mapped account per business
-- (`default_account_settings.setting_key = role_key`).
--
-- Enterprise parity: Odoo/Oracle chart templates guarantee that each "property
-- account" (revenue, expense/purchase, COGS, inventory, clearing, suspense…)
-- points at a real account. A role that is merely "eligible" (some account of
-- the right shape exists) is NOT mapped, and fails late at posting time — this
-- is what produced the "No system default mapped" warning on product
-- purchase/expense accounts.
DO $$
DECLARE
  v_missing text;
BEGIN
  SELECT string_agg(DISTINCT b.id::text || ':' || sr.role_key, ', ')
    INTO v_missing
    FROM public.businesses b
   CROSS JOIN public.system_account_roles sr
    JOIN public.system_account_template st ON st.role_key = sr.role_key
   WHERE sr.category <> 'payroll'
     AND NOT EXISTS (
       SELECT 1
         FROM public.default_account_settings d
         JOIN public.accounts a ON a.id = d.account_id AND coalesce(a.is_active, true)
        WHERE d.business_id = b.id
          AND d.setting_key = sr.role_key
     );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'unmapped default account roles: %', v_missing;
  END IF;

  RAISE NOTICE 'all non-payroll template-backed roles are mapped';
END;
$$;

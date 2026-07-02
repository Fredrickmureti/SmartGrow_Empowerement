
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'pos_waitlist','report_field_configs','automation_execution_tracker',
    'dashboard_spreadsheet_pins','spreadsheet_pivots','spreadsheet_global_filters',
    'spreadsheet_validation_rules','core_field_overrides','entity_field_values',
    'form_layouts','member_permission_groups','permission_groups'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES public.businesses(id) ON DELETE CASCADE', tbl);
    EXECUTE format($f$
      UPDATE public.%I t
      SET business_id = (SELECT b.id FROM public.businesses b WHERE b.organization_id = t.organization_id ORDER BY b.created_at LIMIT 1)
      WHERE t.business_id IS NULL AND t.organization_id IS NOT NULL
    $f$, tbl);
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_org_biz ON public.%I(organization_id, business_id)', tbl, tbl);
  END LOOP;
END$$;

-- pos_waitlist branch_id (idempotent — column may already exist)
ALTER TABLE public.pos_waitlist
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE CASCADE;

UPDATE public.pos_waitlist t
SET branch_id = (
  SELECT br.id FROM public.branches br
  WHERE br.organization_id = t.organization_id
  ORDER BY br.created_at LIMIT 1
)
WHERE t.branch_id IS NULL AND t.organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pos_waitlist_branch ON public.pos_waitlist(branch_id);

-- RESTRICTIVE business-scope policies (helper signature: _user_id, _business_id)
DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'pos_waitlist','report_field_configs','automation_execution_tracker',
    'dashboard_spreadsheet_pins','spreadsheet_pivots','spreadsheet_global_filters',
    'spreadsheet_validation_rules','core_field_overrides','entity_field_values',
    'form_layouts','member_permission_groups','permission_groups'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format($p$DROP POLICY IF EXISTS "%s_business_scope" ON public.%I$p$, tbl, tbl);
    EXECUTE format($p$
      CREATE POLICY "%s_business_scope" ON public.%I
        AS RESTRICTIVE
        FOR ALL
        TO authenticated
        USING (business_id IS NULL OR public.user_can_access_business(auth.uid(), business_id))
        WITH CHECK (business_id IS NULL OR public.user_can_access_business(auth.uid(), business_id))
    $p$, tbl, tbl);
  END LOOP;
END$$;

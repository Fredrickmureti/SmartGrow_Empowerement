-- ============================================================
-- Settings Phase D: Branch-scoped configuration overrides
-- ============================================================

CREATE TABLE IF NOT EXISTS public.branch_overridable_settings (
  setting_key   text PRIMARY KEY,
  display_name  text NOT NULL,
  description   text,
  value_type    text NOT NULL CHECK (value_type IN ('text','number','boolean','json','url')),
  category      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.branch_overridable_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "branch_overridable_settings readable by all authenticated" ON public.branch_overridable_settings;
CREATE POLICY "branch_overridable_settings readable by all authenticated"
  ON public.branch_overridable_settings FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "branch_overridable_settings managed by platform admins" ON public.branch_overridable_settings;
CREATE POLICY "branch_overridable_settings managed by platform admins"
  ON public.branch_overridable_settings FOR ALL TO authenticated
  USING (public.is_platform_admin(auth.uid()))
  WITH CHECK (public.is_platform_admin(auth.uid()));

INSERT INTO public.branch_overridable_settings (setting_key, display_name, description, value_type, category) VALUES
  ('invoice_prefix',    'Invoice number prefix',    'Branch-specific prefix for invoice numbers (e.g. NBO- vs MSA-)', 'text', 'documents'),
  ('receipt_prefix',    'POS receipt prefix',       'Branch-specific prefix for POS receipts',                         'text', 'documents'),
  ('estimate_prefix',   'Estimate number prefix',   'Branch-specific prefix for estimate numbers',                     'text', 'documents'),
  ('bill_prefix',       'Bill number prefix',       'Branch-specific prefix for bill numbers',                         'text', 'documents'),
  ('document_logo_url', 'Document logo',            'Branch-specific logo on PDF documents',                            'url',  'branding'),
  ('document_address',  'Document address block',   'Branch-specific address printed on documents',                    'text', 'branding'),
  ('contact_email',     'Branch contact email',     'Email shown on documents and to customers',                        'text', 'contact'),
  ('contact_phone',     'Branch contact phone',     'Phone shown on documents and to customers',                        'text', 'contact')
ON CONFLICT (setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.branch_setting_overrides (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id       uuid NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_id     uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  setting_key     text NOT NULL REFERENCES public.branch_overridable_settings(setting_key),
  setting_value   jsonb NOT NULL,
  set_by          uuid REFERENCES auth.users(id),
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, setting_key)
);
CREATE INDEX IF NOT EXISTS idx_branch_overrides_org ON public.branch_setting_overrides (organization_id);
CREATE INDEX IF NOT EXISTS idx_branch_overrides_branch ON public.branch_setting_overrides (branch_id);

ALTER TABLE public.branch_setting_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "branch_overrides readable by org members" ON public.branch_setting_overrides;
CREATE POLICY "branch_overrides readable by org members"
  ON public.branch_setting_overrides FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

DROP POLICY IF EXISTS "branch_overrides writable by org admins" ON public.branch_setting_overrides;
CREATE POLICY "branch_overrides writable by org admins"
  ON public.branch_setting_overrides FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'super_admin'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'super_admin'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'owner'::app_role)
    OR public.has_role(auth.uid(), organization_id, 'admin'::app_role)
  );

DROP TRIGGER IF EXISTS trg_branch_overrides_updated_at ON public.branch_setting_overrides;
CREATE TRIGGER trg_branch_overrides_updated_at
  BEFORE UPDATE ON public.branch_setting_overrides
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.resolve_branch_setting(p_branch_id uuid, p_setting_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_override jsonb; v_branch RECORD;
BEGIN
  IF p_branch_id IS NULL OR p_setting_key IS NULL THEN
    RETURN jsonb_build_object('value', NULL, 'source', 'none', 'is_overridden', false);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branch_overridable_settings WHERE setting_key = p_setting_key) THEN
    RAISE EXCEPTION 'Setting key % is not branch-overridable', p_setting_key USING ERRCODE='22023';
  END IF;
  SELECT id, business_id, organization_id INTO v_branch FROM public.branches WHERE id = p_branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Branch % not found', p_branch_id USING ERRCODE='P0002'; END IF;
  SELECT setting_value INTO v_override FROM public.branch_setting_overrides
   WHERE branch_id = p_branch_id AND setting_key = p_setting_key;
  IF v_override IS NOT NULL THEN
    RETURN jsonb_build_object('value', v_override, 'source', 'branch_override', 'is_overridden', true,
                              'branch_id', p_branch_id, 'business_id', v_branch.business_id);
  END IF;
  RETURN jsonb_build_object('value', NULL, 'source', 'inherited', 'is_overridden', false,
                            'branch_id', p_branch_id, 'business_id', v_branch.business_id,
                            'organization_id', v_branch.organization_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.resolve_branch_setting(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_branch_setting(p_branch_id uuid, p_setting_key text, p_value jsonb, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_branch RECORD; v_existing jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branch_overridable_settings WHERE setting_key = p_setting_key) THEN
    RAISE EXCEPTION 'Setting key % is not branch-overridable', p_setting_key USING ERRCODE='22023';
  END IF;
  SELECT id, business_id, organization_id INTO v_branch FROM public.branches WHERE id = p_branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Branch % not found', p_branch_id USING ERRCODE='P0002'; END IF;
  IF NOT (
    public.has_role(v_user, v_branch.organization_id, 'super_admin'::app_role)
    OR public.has_role(v_user, v_branch.organization_id, 'owner'::app_role)
    OR public.has_role(v_user, v_branch.organization_id, 'admin'::app_role)
  ) THEN RAISE EXCEPTION 'Only org admins/owners can override branch settings' USING ERRCODE='42501'; END IF;
  SELECT setting_value INTO v_existing FROM public.branch_setting_overrides
   WHERE branch_id = p_branch_id AND setting_key = p_setting_key;
  INSERT INTO public.branch_setting_overrides
    (branch_id, organization_id, business_id, setting_key, setting_value, set_by, reason)
  VALUES
    (p_branch_id, v_branch.organization_id, v_branch.business_id, p_setting_key, p_value, v_user, p_reason)
  ON CONFLICT (branch_id, setting_key) DO UPDATE SET
    setting_value = EXCLUDED.setting_value, set_by = EXCLUDED.set_by,
    reason = EXCLUDED.reason, updated_at = now();
  INSERT INTO public.audit_logs (organization_id, user_id, action, entity_type, entity_id, entity_name,
    changes_summary, old_values, new_values)
  VALUES (v_branch.organization_id, v_user,
    CASE WHEN v_existing IS NULL THEN 'created' ELSE 'updated' END,
    'branch_setting_override', p_branch_id, p_setting_key,
    'Branch setting override ' || p_setting_key || COALESCE(' — ' || p_reason, ''),
    jsonb_build_object('value', v_existing), jsonb_build_object('value', p_value));
  RETURN jsonb_build_object('success', true, 'branch_id', p_branch_id, 'setting_key', p_setting_key, 'value', p_value);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_branch_setting(uuid, text, jsonb, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.clear_branch_setting(p_branch_id uuid, p_setting_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user uuid := auth.uid(); v_branch RECORD; v_old jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  SELECT id, business_id, organization_id INTO v_branch FROM public.branches WHERE id = p_branch_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Branch % not found', p_branch_id USING ERRCODE='P0002'; END IF;
  IF NOT (
    public.has_role(v_user, v_branch.organization_id, 'super_admin'::app_role)
    OR public.has_role(v_user, v_branch.organization_id, 'owner'::app_role)
    OR public.has_role(v_user, v_branch.organization_id, 'admin'::app_role)
  ) THEN RAISE EXCEPTION 'Only org admins/owners can clear branch settings' USING ERRCODE='42501'; END IF;
  DELETE FROM public.branch_setting_overrides
   WHERE branch_id = p_branch_id AND setting_key = p_setting_key
   RETURNING setting_value INTO v_old;
  IF v_old IS NOT NULL THEN
    INSERT INTO public.audit_logs (organization_id, user_id, action, entity_type, entity_id, entity_name,
      changes_summary, old_values, new_values)
    VALUES (v_branch.organization_id, v_user, 'deleted',
      'branch_setting_override', p_branch_id, p_setting_key,
      'Cleared branch override for ' || p_setting_key,
      jsonb_build_object('value', v_old), jsonb_build_object('value', NULL));
  END IF;
  RETURN jsonb_build_object('success', true, 'branch_id', p_branch_id, 'setting_key', p_setting_key, 'cleared', v_old IS NOT NULL);
END;
$$;
GRANT EXECUTE ON FUNCTION public.clear_branch_setting(uuid, text) TO authenticated;
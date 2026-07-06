
-- ADR 0060 follow-through: SQL-side publish helper + Kenya v-next release.
-- No tenant data is written; the only tenant-visible effect is a new row in
-- `pack_upgrade_proposals` per installed tenant (the standard upgrade inbox).

CREATE OR REPLACE FUNCTION public.publish_localization_pack_version_sql(
  p_pack_id uuid,
  p_version text,
  p_notes text DEFAULT NULL,
  p_publisher uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_prev pack_versions%ROWTYPE;
  v_snapshot jsonb;
  v_pack jsonb;
  v_version_id uuid;
  v_proposals int := 0;
  v_install RECORD;
BEGIN
  IF p_pack_id IS NULL OR p_version IS NULL THEN
    RAISE EXCEPTION 'pack_id and version are required';
  END IF;

  SELECT * INTO v_prev
  FROM pack_versions
  WHERE pack_id = p_pack_id AND status = 'published'
  ORDER BY published_at DESC NULLS LAST
  LIMIT 1;

  IF v_prev.id IS NOT NULL AND v_prev.version = p_version THEN
    RAISE EXCEPTION 'Version % already published for this pack', p_version;
  END IF;

  SELECT to_jsonb(p) INTO v_pack FROM localization_packs p WHERE p.id = p_pack_id;
  IF v_pack IS NULL THEN
    RAISE EXCEPTION 'Localization pack % not found', p_pack_id;
  END IF;

  v_snapshot := jsonb_build_object(
    '_pack', jsonb_build_array(v_pack),
    'localization_pack_payroll_templates',
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM localization_pack_payroll_templates t WHERE t.pack_id = p_pack_id), '[]'::jsonb),
    'localization_pack_account_templates',
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM localization_pack_account_templates t WHERE t.pack_id = p_pack_id), '[]'::jsonb),
    'localization_pack_tax_templates',
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM localization_pack_tax_templates t WHERE t.pack_id = p_pack_id), '[]'::jsonb),
    'localization_pack_certificate_templates',
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.code) FROM localization_pack_certificate_templates t WHERE t.pack_id = p_pack_id), '[]'::jsonb),
    'localization_pack_return_templates',
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.code) FROM localization_pack_return_templates t WHERE t.pack_id = p_pack_id), '[]'::jsonb),
    'localization_pack_remittance_schedules',
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM localization_pack_remittance_schedules t WHERE t.pack_id = p_pack_id), '[]'::jsonb),
    'localization_pack_work_entry_type_templates',
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM localization_pack_work_entry_type_templates t WHERE t.pack_id = p_pack_id), '[]'::jsonb),
    'pack_token_registry',
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.id) FROM pack_token_registry t WHERE t.pack_id = p_pack_id), '[]'::jsonb),
    'pack_rule_type_schemas',
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.rule_type, t.computation_kind, t.schema_version) FROM pack_rule_type_schemas t), '[]'::jsonb)
  );

  INSERT INTO pack_versions
    (pack_id, version, status, changelog, snapshot, published_at, published_by, created_by, parent_version_id)
  VALUES
    (p_pack_id, p_version, 'published',
     jsonb_build_object('notes', p_notes, 'from', v_prev.version, 'to', p_version, 'source', 'publish_localization_pack_version_sql'),
     v_snapshot, now(), p_publisher, p_publisher, v_prev.id)
  RETURNING id INTO v_version_id;

  -- Reflect the new latest version on the pack row itself so tenants and
  -- editors surface the correct version without a round-trip.
  UPDATE localization_packs
     SET version = p_version, updated_at = now()
   WHERE id = p_pack_id;

  -- Fan-out proposals for every installed tenant NOT already on this version.
  IF v_prev.id IS NOT NULL THEN
    FOR v_install IN
      SELECT organization_id, business_id, pack_version
      FROM installed_localization_packs
      WHERE pack_id = p_pack_id AND pack_version <> p_version
    LOOP
      BEGIN
        INSERT INTO pack_upgrade_proposals
          (organization_id, business_id, pack_id, from_version, to_version, diff, status)
        VALUES
          (v_install.organization_id, v_install.business_id, p_pack_id,
           COALESCE(v_install.pack_version, v_prev.version), p_version,
           jsonb_build_object('notes', p_notes, 'from', v_install.pack_version, 'to', p_version),
           'pending');
        v_proposals := v_proposals + 1;
      EXCEPTION WHEN unique_violation THEN
        -- Tenant already has a pending proposal for this version.
        CONTINUE;
      END;
    END LOOP;
  END IF;

  RAISE NOTICE 'Published pack % version % (previous %) — % proposals created',
    p_pack_id, p_version, v_prev.version, v_proposals;

  RETURN v_version_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.publish_localization_pack_version_sql(uuid, text, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.publish_localization_pack_version_sql(uuid, text, text, uuid) TO service_role;

COMMENT ON FUNCTION public.publish_localization_pack_version_sql(uuid, text, text, uuid) IS
'ADR 0060: Publish a new immutable pack_versions snapshot for the given pack and enqueue upgrade proposals for every installed tenant. SECURITY DEFINER + service_role only; RLS is bypassed by design because this is the platform-side publisher path invoked from migrations and the publish edge function fallback.';

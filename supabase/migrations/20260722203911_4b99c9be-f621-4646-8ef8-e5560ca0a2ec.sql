
-- Extend assert_certificate_template_body_valid to enforce the canonical
-- column-binding contract enforced at runtime by
-- supabase/functions/generate-tax-certificate/index.ts::validateCanonicalSourceNode.
-- Mirrors the TS check so a structurally broken template cannot be persisted.
CREATE OR REPLACE FUNCTION public.assert_certificate_template_body_valid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  _schema jsonb;
  _errs text[];
  _v int;
  _binding_errs text[] := ARRAY[]::text[];
BEGIN
  IF NEW.body IS NULL THEN
    RAISE EXCEPTION 'Certificate template % has NULL body', NEW.code;
  END IF;

  _v := COALESCE((NEW.body->>'schema_version')::int, 1);
  IF _v < 3 THEN
    RAISE EXCEPTION
      'Certificate template % rejected: schema_version=% is below the minimum (3). '
      'The pdf-lib v1/v2 renderers have been retired; author the body as a v3 engine AST.',
      NEW.code, _v;
  END IF;

  -- Column-binding contract: for every grid / matrix / table node found
  -- anywhere in the document tree, every non-month data column must have
  -- a `source_key` OR appear as a key in `derived_columns`. Otherwise the
  -- column silently renders as zero on a statutory document.
  WITH RECURSIVE nodes(node) AS (
    SELECT n
    FROM jsonb_array_elements(COALESCE(NEW.body->'document','[]'::jsonb)) AS n
    UNION ALL
    SELECT child
    FROM nodes,
    LATERAL (
      SELECT jsonb_array_elements(node->'children') AS child
      WHERE jsonb_typeof(node->'children') = 'array'
      UNION ALL
      SELECT jsonb_array_elements(sub) AS child
      FROM jsonb_array_elements(COALESCE(node->'column_children','[]'::jsonb)) AS sub
      WHERE jsonb_typeof(node->'column_children') = 'array'
        AND jsonb_typeof(sub) = 'array'
    ) AS unpacked(child)
  ),
  data_nodes AS (
    SELECT node
    FROM nodes
    WHERE node->>'type' IN ('grid','matrix','table')
  ),
  offences AS (
    SELECT
      dn.node->>'type' AS node_type,
      col->>'id'   AS col_id,
      col->>'key'  AS col_key
    FROM data_nodes dn,
         LATERAL jsonb_array_elements(COALESCE(dn.node->'columns','[]'::jsonb)) AS col
    WHERE
      -- month columns are always allowed unbound
      COALESCE(col->>'id','')   NOT IN ('month','month_index')
      AND COALESCE(col->>'key','')  NOT IN ('month','month_index')
      AND COALESCE(lower(col->>'format'),'') <> 'month_short'
      -- non-empty target key
      AND COALESCE(col->>'key', col->>'bind_key', col->>'id','') <> ''
      -- unbound: no source_key
      AND COALESCE(col->>'source_key','') = ''
      -- AND not declared as a derived key
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(dn.node->'derived_columns','[]'::jsonb)) AS d
        WHERE d->>'key' = COALESCE(col->>'key', col->>'bind_key', col->>'id')
      )
  )
  SELECT array_agg(
    format('%s column %s',
           node_type,
           COALESCE(col_key, col_id, '?'))
  )
  INTO _binding_errs
  FROM offences;

  IF _binding_errs IS NOT NULL AND array_length(_binding_errs, 1) > 0 THEN
    RAISE EXCEPTION
      'Certificate template % rejected: unbound data column(s): %. '
      'Every non-month column must set `source_key` (canonical rule code) '
      'or appear as a key in the node''s `derived_columns`. Statutory templates '
      'must never render unbound zeros.',
      NEW.code,
      array_to_string(_binding_errs, ', ');
  END IF;

  SELECT json_schema INTO _schema
  FROM public.pack_rule_type_schemas
  WHERE rule_type='certificate_template' AND computation_kind='v2'
  ORDER BY schema_version DESC LIMIT 1;

  IF _schema IS NULL THEN
    NEW.legacy_unvalidated := true;
    RETURN NEW;
  END IF;

  -- v3 bodies do not carry data_source at root; skip the v2 shape check for them.
  IF _v >= 3 THEN
    NEW.legacy_unvalidated := false;
    RETURN NEW;
  END IF;

  IF NOT (NEW.body ? 'data_source') THEN
    NEW.legacy_unvalidated := true;
    RETURN NEW;
  END IF;

  _errs := public.validate_jsonb_against_schema(NEW.body, _schema);
  IF array_length(_errs,1) > 0 THEN
    RAISE EXCEPTION 'Invalid certificate template body for % : %',
      NEW.code, array_to_string(_errs,'; ');
  END IF;
  NEW.legacy_unvalidated := false;
  RETURN NEW;
END;
$function$;

-- Backfill audit: log a diagnostics row for every existing pack template
-- whose body would fail the tightened contract, so publishers can see it
-- without needing to attempt a regeneration.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    WITH RECURSIVE nodes(tpl_id, tpl_code, pack_id, node) AS (
      SELECT t.id, t.code, t.pack_id, n
      FROM public.localization_pack_certificate_templates t,
           LATERAL jsonb_array_elements(COALESCE(t.body->'document','[]'::jsonb)) AS n
      UNION ALL
      SELECT tpl_id, tpl_code, pack_id, child
      FROM nodes,
      LATERAL (
        SELECT jsonb_array_elements(node->'children') AS child
        WHERE jsonb_typeof(node->'children') = 'array'
        UNION ALL
        SELECT jsonb_array_elements(sub) AS child
        FROM jsonb_array_elements(COALESCE(node->'column_children','[]'::jsonb)) AS sub
        WHERE jsonb_typeof(node->'column_children') = 'array'
          AND jsonb_typeof(sub) = 'array'
      ) AS unpacked(child)
    )
    SELECT tpl_code, pack_id,
      array_agg(node->>'type' || ':' || COALESCE(col->>'key', col->>'bind_key', col->>'id', '?')) AS offences
    FROM nodes,
         LATERAL jsonb_array_elements(COALESCE(node->'columns','[]'::jsonb)) AS col
    WHERE node->>'type' IN ('grid','matrix','table')
      AND COALESCE(col->>'id','')   NOT IN ('month','month_index')
      AND COALESCE(col->>'key','')  NOT IN ('month','month_index')
      AND COALESCE(lower(col->>'format'),'') <> 'month_short'
      AND COALESCE(col->>'key', col->>'bind_key', col->>'id','') <> ''
      AND COALESCE(col->>'source_key','') = ''
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(node->'derived_columns','[]'::jsonb)) d
        WHERE d->>'key' = COALESCE(col->>'key', col->>'bind_key', col->>'id')
      )
    GROUP BY tpl_code, pack_id
  LOOP
    -- payroll_diagnostics may not exist in every environment; guard with a
    -- to_regclass check.
    IF to_regclass('public.payroll_diagnostics') IS NOT NULL THEN
      EXECUTE format(
        'INSERT INTO public.payroll_diagnostics
           (pack_id, template_code, surface, severity, code, message, details)
         VALUES (%L::uuid, %L, %L, %L, %L, %L, %L::jsonb)',
        r.pack_id, r.tpl_code, 'certificate', 'warning',
        'TEMPLATE_COLUMN_UNBOUND',
        'Certificate template ' || r.tpl_code || ' has unbound data column(s); regeneration will refuse until republished.',
        jsonb_build_object('offences', r.offences)::text
      );
    END IF;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.garnishment_resolve_kinds(uuid);

CREATE OR REPLACE FUNCTION public.garnishment_resolve_kinds(p_org_id uuid)
RETURNS TABLE (
  kind text,
  label text,
  default_priority int,
  always_first boolean,
  counts_toward_aggregate_cap boolean,
  max_concurrent int,
  employer_fee_amount numeric,
  required_identifiers jsonb,
  evidence_required boolean,
  source text,
  source_pack_id uuid,
  calc_model public.legal_order_calc_model,
  priority_class smallint,
  protected_earnings_rule jsonb,
  aggregate_cap_membership public.legal_order_cap_membership
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH pack_kinds AS (
    SELECT
      k.code AS kind,
      k.label,
      k.default_priority,
      k.always_first,
      k.counts_toward_aggregate_cap,
      k.max_concurrent,
      k.employer_fee_amount,
      k.required_identifiers,
      k.evidence_required,
      k.pack_id,
      k.calc_model,
      k.priority_class,
      COALESCE(k.protected_earnings_rule, '{}'::jsonb) AS protected_earnings_rule,
      k.aggregate_cap_membership
    FROM public.localization_pack_garnishment_kinds k
    JOIN public.installed_localization_packs i ON i.pack_id = k.pack_id
    JOIN public.businesses b ON b.id = i.business_id
    WHERE b.organization_id = p_org_id
      AND i.status = 'active'
      AND k.is_active = true
  ),
  tenant_overrides AS (
    SELECT
      g.kind,
      NULL::text AS label,
      g.default_priority,
      g.always_first,
      g.counts_toward_aggregate_cap,
      g.max_concurrent,
      g.employer_fee_amount,
      g.required_identifiers,
      g.evidence_required,
      g.source_pack_id AS pack_id,
      g.calc_model,
      g.priority_class,
      COALESCE(g.protected_earnings_rule, '{}'::jsonb) AS protected_earnings_rule,
      g.aggregate_cap_membership
    FROM public.garnishment_kind_defaults g
    WHERE g.organization_id = p_org_id
  ),
  platform_defaults AS (
    SELECT
      g.kind,
      NULL::text AS label,
      g.default_priority,
      g.always_first,
      g.counts_toward_aggregate_cap,
      g.max_concurrent,
      g.employer_fee_amount,
      g.required_identifiers,
      g.evidence_required,
      NULL::uuid AS pack_id,
      g.calc_model,
      g.priority_class,
      COALESCE(g.protected_earnings_rule, '{}'::jsonb) AS protected_earnings_rule,
      g.aggregate_cap_membership
    FROM public.garnishment_kind_defaults g
    WHERE g.organization_id IS NULL
  ),
  merged AS (
    SELECT *, 'tenant'::text AS source FROM tenant_overrides
    UNION ALL
    SELECT *, 'pack'::text AS source FROM pack_kinds
    UNION ALL
    SELECT *, 'platform'::text AS source FROM platform_defaults
  ),
  ranked AS (
    SELECT
      m.*,
      row_number() OVER (
        PARTITION BY m.kind
        ORDER BY CASE m.source WHEN 'tenant' THEN 0 WHEN 'pack' THEN 1 ELSE 2 END
      ) AS rn
    FROM merged m
  )
  SELECT
    kind,
    COALESCE(label, kind) AS label,
    COALESCE(default_priority, 100) AS default_priority,
    COALESCE(always_first, false) AS always_first,
    COALESCE(counts_toward_aggregate_cap, true) AS counts_toward_aggregate_cap,
    max_concurrent,
    employer_fee_amount,
    COALESCE(required_identifiers, '[]'::jsonb) AS required_identifiers,
    COALESCE(evidence_required, false) AS evidence_required,
    source,
    pack_id AS source_pack_id,
    COALESCE(calc_model, 'fixed'::public.legal_order_calc_model) AS calc_model,
    priority_class,
    COALESCE(protected_earnings_rule, '{}'::jsonb) AS protected_earnings_rule,
    COALESCE(
      aggregate_cap_membership,
      CASE
        WHEN COALESCE(always_first, false) THEN 'always_first'::public.legal_order_cap_membership
        WHEN NOT COALESCE(counts_toward_aggregate_cap, true) THEN 'exempt'::public.legal_order_cap_membership
        ELSE 'in_pool'::public.legal_order_cap_membership
      END
    ) AS aggregate_cap_membership
  FROM ranked
  WHERE rn = 1
  ORDER BY COALESCE(always_first, false) DESC, COALESCE(default_priority, 100) ASC, kind ASC;
$$;

GRANT EXECUTE ON FUNCTION public.garnishment_resolve_kinds(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.garnishment_resolve_kinds(uuid) IS
  'Resolves tenant, localization-pack, then platform legal-order kind behavior for payroll. Includes canonical calc_model, priority_class, protected earnings, and cap membership fields consumed by the shared garnishment engine.';
-- Phase 6 — jurisdiction packs. Retry: garnishment_kind_defaults has no
-- updated_at column, so the platform-default hardening UPDATE now omits it.

UPDATE public.garnishment_kind_defaults
SET priority_class = CASE kind
    WHEN 'child_support'   THEN 10
    WHEN 'court_order'     THEN 20
    WHEN 'tax_levy'        THEN 30
    WHEN 'student_loan'    THEN 40
    WHEN 'wage_assignment' THEN 50
    WHEN 'creditor'        THEN 60
    WHEN 'other'           THEN 99
    ELSE priority_class
  END
WHERE organization_id IS NULL
  AND kind IN ('child_support','court_order','tax_levy','student_loan',
               'wage_assignment','creditor','other');

INSERT INTO public.garnishment_kind_defaults
  (kind, default_priority, always_first, counts_toward_aggregate_cap,
   description, employer_fee_amount, required_identifiers, evidence_required,
   calc_model, priority_class, protected_earnings_rule,
   aggregate_cap_membership, evidence_requirements)
VALUES
  ('alimony',          15, true,  false, 'Spousal support / alimony order',
   0, '[]'::jsonb, true, 'fixed', 10, '{}'::jsonb, 'always_first', '{}'::jsonb),
  ('medical_support',  18, true,  false, 'National Medical Support Notice (health-insurance withholding)',
   0, '[]'::jsonb, true, 'fixed', 10, '{}'::jsonb, 'always_first', '{}'::jsonb),
  ('bankruptcy_order', 25, false, true,  'Bankruptcy trustee wage attachment',
   0, '[]'::jsonb, true, 'fixed', 20, '{}'::jsonb, 'in_pool', '{}'::jsonb),
  ('sacco_loan',       55, false, true,  'Employer-facilitated SACCO / credit-union loan repayment',
   0, '[]'::jsonb, false,'fixed', 50, '{}'::jsonb, 'in_pool', '{}'::jsonb),
  ('union_dues',       58, false, true,  'Union / professional-body dues check-off',
   0, '[]'::jsonb, false,'fixed', 50, '{}'::jsonb, 'in_pool', '{}'::jsonb)
ON CONFLICT (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), kind)
DO NOTHING;

-- Pack seeding: KE / ZA / GH / DE. Each block is idempotent and skips when
-- the target pack row does not exist. See ADR-0095 for jurisdiction
-- rationale.

DO $seed_ke$
DECLARE v_pack_id uuid;
BEGIN
  SELECT id INTO v_pack_id FROM public.localization_packs
    WHERE country_code = 'KE'
    ORDER BY (is_published)::int DESC, updated_at DESC LIMIT 1;
  IF v_pack_id IS NULL THEN RAISE NOTICE 'KE pack not present; skipping'; RETURN; END IF;

  INSERT INTO public.localization_pack_garnishment_kinds
    (pack_id, code, label, default_priority, always_first,
     counts_toward_aggregate_cap, employer_fee_amount, calc_model,
     priority_class, protected_earnings_rule, aggregate_cap_membership,
     description, is_active)
  VALUES
    (v_pack_id, 'child_support', 'Kenya — Child Maintenance Order',
     10, true, false, 0, 'fixed', 10,
     jsonb_build_object('min_pct_of_gross', 0.3333), 'always_first',
     'Children Act Cap 141 — child maintenance withholding, first priority.', true),
    (v_pack_id, 'court_order', 'Kenya — Court Order (Civil Procedure)',
     20, false, true, 0, 'fixed', 20,
     jsonb_build_object('min_pct_of_gross', 0.3333), 'in_pool',
     'Civil Procedure Act Cap 21 — attachment of earnings capped at 1/3 of gross.', true),
    (v_pack_id, 'tax_levy', 'Kenya — KRA Agency Notice',
     30, false, true, 0, 'fixed', 30, '{}'::jsonb, 'in_pool',
     'Tax Procedures Act §42 — KRA agency notice.', true)
  ON CONFLICT DO NOTHING;
END $seed_ke$;

DO $seed_za$
DECLARE v_pack_id uuid;
BEGIN
  SELECT id INTO v_pack_id FROM public.localization_packs
    WHERE country_code = 'ZA'
    ORDER BY (is_published)::int DESC, updated_at DESC LIMIT 1;
  IF v_pack_id IS NULL THEN RAISE NOTICE 'ZA pack not present; skipping'; RETURN; END IF;

  INSERT INTO public.localization_pack_garnishment_kinds
    (pack_id, code, label, default_priority, always_first,
     counts_toward_aggregate_cap, employer_fee_amount, calc_model,
     priority_class, protected_earnings_rule, aggregate_cap_membership,
     description, is_active)
  VALUES
    (v_pack_id, 'child_support', 'South Africa — Maintenance Order',
     10, true, false, 0, 'fixed', 10,
     jsonb_build_object('min_pct_of_gross', 0.75), 'always_first',
     'Maintenance Act §26 — maintenance order, first priority.', true),
    (v_pack_id, 'court_order', 'South Africa — Emoluments Attachment Order',
     20, false, true, 0, 'fixed', 20,
     jsonb_build_object('min_pct_of_gross', 0.75), 'in_pool',
     'Magistrates'' Courts Act §65J — EAO capped at 25% of gross remuneration.', true),
    (v_pack_id, 'tax_levy', 'South Africa — SARS Third-Party Appointment',
     30, false, true, 0, 'fixed', 30, '{}'::jsonb, 'in_pool',
     'Tax Administration Act §179 — SARS third-party appointment.', true)
  ON CONFLICT DO NOTHING;
END $seed_za$;

DO $seed_gh$
DECLARE v_pack_id uuid;
BEGIN
  SELECT id INTO v_pack_id FROM public.localization_packs
    WHERE country_code = 'GH'
    ORDER BY (is_published)::int DESC, updated_at DESC LIMIT 1;
  IF v_pack_id IS NULL THEN RAISE NOTICE 'GH pack not present; skipping'; RETURN; END IF;

  INSERT INTO public.localization_pack_garnishment_kinds
    (pack_id, code, label, default_priority, always_first,
     counts_toward_aggregate_cap, employer_fee_amount, calc_model,
     priority_class, protected_earnings_rule, aggregate_cap_membership,
     description, is_active)
  VALUES
    (v_pack_id, 'child_support', 'Ghana — Maintenance Order',
     10, true, false, 0, 'fixed', 10,
     jsonb_build_object('min_pct_of_gross', 0.6666), 'always_first',
     'Children''s Act 560 — maintenance withholding.', true),
    (v_pack_id, 'court_order', 'Ghana — High Court Garnishee Order',
     20, false, true, 0, 'fixed', 20,
     jsonb_build_object('min_pct_of_gross', 0.6666), 'in_pool',
     'Labour Act 651 §69 — deductions capped at 1/3 of monthly earnings.', true),
    (v_pack_id, 'tax_levy', 'Ghana — GRA Distress Warrant',
     30, false, true, 0, 'fixed', 30, '{}'::jsonb, 'in_pool',
     'Revenue Administration Act 915 — GRA distress action.', true)
  ON CONFLICT DO NOTHING;
END $seed_gh$;

DO $seed_de$
DECLARE v_pack_id uuid;
BEGIN
  SELECT id INTO v_pack_id FROM public.localization_packs
    WHERE country_code = 'DE'
    ORDER BY (is_published)::int DESC, updated_at DESC LIMIT 1;
  IF v_pack_id IS NULL THEN RAISE NOTICE 'DE pack not present; skipping'; RETURN; END IF;

  INSERT INTO public.localization_pack_garnishment_kinds
    (pack_id, code, label, default_priority, always_first,
     counts_toward_aggregate_cap, employer_fee_amount, calc_model,
     priority_class, protected_earnings_rule, aggregate_cap_membership,
     description, is_active)
  VALUES
    (v_pack_id, 'child_support', 'Germany — Unterhaltspfändung',
     10, true, false, 0, 'fixed', 10,
     jsonb_build_object('min_amount', 1178.59), 'always_first',
     'ZPO §850d — Unterhaltspfändung (priority over ordinary attachment).', true),
    (v_pack_id, 'court_order', 'Germany — Lohnpfändung',
     20, false, true, 0, 'fixed', 20,
     jsonb_build_object('min_amount', 1560.00), 'in_pool',
     'ZPO §850c — Pfändungsfreigrenze (single, no dependents, 2024 band).', true),
    (v_pack_id, 'tax_levy', 'Germany — Finanzamt Pfändung',
     30, false, true, 0, 'fixed', 30,
     jsonb_build_object('min_amount', 1560.00), 'in_pool',
     'AO §309 — Finanzamt wage attachment.', true)
  ON CONFLICT DO NOTHING;
END $seed_de$;

-- Effective-defaults read view.
DROP VIEW IF EXISTS public.legal_order_effective_kind_defaults;
CREATE VIEW public.legal_order_effective_kind_defaults
  WITH (security_invoker = true) AS
SELECT
  o.id AS organization_id,
  r.kind, r.label, r.default_priority, r.always_first,
  r.counts_toward_aggregate_cap, r.max_concurrent, r.employer_fee_amount,
  r.required_identifiers, r.evidence_required, r.source, r.source_pack_id,
  r.calc_model, r.priority_class, r.protected_earnings_rule,
  r.aggregate_cap_membership
FROM public.organizations o
CROSS JOIN LATERAL public.garnishment_resolve_kinds(o.id) r;

GRANT SELECT ON public.legal_order_effective_kind_defaults TO authenticated;
GRANT ALL   ON public.legal_order_effective_kind_defaults TO service_role;

COMMENT ON VIEW public.legal_order_effective_kind_defaults IS
'Phase 6: per-org resolved garnishment kinds (tenant > pack > platform). Read surface for the Legal Orders Packs workspace tab.';

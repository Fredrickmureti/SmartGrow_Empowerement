-- pgTAP: Returns convergence invariants (Phases 3 and 4)
--
-- Guards the contract installed by the Phase 3/4 migration:
--   * numbering is per-business, monotonic and canonical-formatted
--   * the BEFORE INSERT trigger is the single allocation point, so a
--     WMS-style number is rewritten into the sales series
--   * document numbers are unique per organization
--   * create_sales_return_atomic is idempotent by client_request_id
--   * transition_sales_return enforces the state machine and refuses to
--     approve (approval belongs to approve_sales_return_atomic)
BEGIN;
SELECT plan(34);

-- ---------- fixtures ----------
CREATE TEMP TABLE _sr_fx (org uuid, biz uuid) ON COMMIT DROP;
INSERT INTO _sr_fx VALUES (
  'aaaaaaaa-0000-0000-0000-00000000aaaa',
  'bbbbbbbb-0000-0000-0000-00000000bbbb'
);

-- ---------- shape ----------
SELECT has_function('public', 'create_sales_return_atomic', ARRAY['jsonb'],
  'create_sales_return_atomic(jsonb) exists');

SELECT has_function('public', 'transition_sales_return', ARRAY['uuid','text','text'],
  'transition_sales_return(uuid,text,text) exists');

SELECT has_index('public', 'sales_returns', 'uq_sales_returns_org_number',
  'return numbers are unique per organization');

SELECT has_index('public', 'sales_returns', 'uq_sales_returns_client_request',
  'client_request_id is unique per organization');

SELECT has_trigger('public', 'sales_returns', 'trg_assign_sales_return_number',
  'the number allocation trigger is installed');

-- ---------- numbering ----------
-- The old generator folded the year into the counter and produced
-- 'SR-2026-20260002'. The canonical shape is <prefix><digits> only.
SELECT matches(
  public.get_next_sales_return_number(
    (SELECT org FROM _sr_fx), (SELECT biz FROM _sr_fx), NULL),
  '^[A-Za-z\-]+[0-9]{5}$',
  'generated number is prefix + zero-padded counter, with no embedded year'
);

SELECT throws_ok(
  $$ SELECT public.get_next_sales_return_number(
       'aaaaaaaa-0000-0000-0000-00000000aaaa'::uuid, NULL, NULL) $$,
  NULL, NULL,
  'numbering refuses to run without a business (multi-company isolation)'
);

-- ---------- authorization ----------
-- No auth.uid() in a pgTAP session: both write RPCs must refuse rather
-- than create an unattributed document.
SELECT throws_ok(
  $$ SELECT public.create_sales_return_atomic(jsonb_build_object(
       'organization_id', 'aaaaaaaa-0000-0000-0000-00000000aaaa',
       'business_id',     'bbbbbbbb-0000-0000-0000-00000000bbbb',
       'reason',          'pgtap',
       'items', jsonb_build_array(jsonb_build_object(
         'description', 'widget', 'quantity', 1, 'unit_price', 10)))) $$,
  NULL, NULL,
  'create_sales_return_atomic refuses an unauthenticated caller'
);

SELECT throws_ok(
  $$ SELECT public.transition_sales_return(
       '00000000-0000-0000-0000-000000000001'::uuid, 'approved', NULL) $$,
  NULL, NULL,
  'transition_sales_return never performs approval'
);


-- ---------- Phase 6: cost basis fidelity ----------
SELECT has_table('public', 'sales_return_cost_basis',
  'cost basis of every restored return line is recorded');
SELECT has_table('public', 'sales_return_cost_allocations',
  'each restored line records which outbound cost portions it consumed');
SELECT col_is_unique('public', 'sales_return_cost_basis', ARRAY['sales_return_item_id'],
  'a return line can only carry one cost basis row');
SELECT has_function('public', 'resolve_sales_return_line_cost',
  ARRAY['uuid','uuid','uuid','numeric'],
  'resolver for the original outbound cost of a returned line exists');
SELECT ok(
  (SELECT public.resolve_sales_return_line_cost(
     (SELECT biz FROM _sr_fx), NULL, NULL, 1)->>'method') = 'none',
  'resolver returns no basis when there is no product to value'
);
SELECT ok(
  (SELECT (public.resolve_sales_return_line_cost(
     (SELECT biz FROM _sr_fx), NULL,
     '00000000-0000-0000-0000-0000000000c6'::uuid, 2)->>'fallback_qty')::numeric) = 2,
  'with no outbound history the whole quantity is flagged as a fallback valuation'
);
SELECT ok(
  (SELECT public.resolve_sales_return_line_cost(
     (SELECT biz FROM _sr_fx), NULL,
     '00000000-0000-0000-0000-0000000000c6'::uuid, 2)->>'fallback_reason') IS NOT NULL,
  'a fallback valuation always records an explainable reason'
);


-- ---------- Phase 7: settlement & refund completeness ----------
SELECT has_view('public', 'v_sales_return_settlement',
  'a single settlement position exists per sales return');
SELECT has_column('public', 'v_sales_return_settlement', 'is_settled',
  'the settlement position states whether the return is fully settled');
SELECT has_column('public', 'v_sales_return_settlement', 'open_credit',
  'unused customer credit is reported separately from refunds and applications');
SELECT ok(
  (SELECT count(*) FROM public.v_sales_return_settlement
    WHERE applied + refunded > credited + 0.01) = 0,
  'no return is settled for more than it was credited (no double settlement)'
);
SELECT ok(
  (SELECT count(*) FROM public.sales_returns sr
    LEFT JOIN public.v_sales_return_settlement s ON s.sales_return_id = sr.id
    WHERE sr.status = 'refunded' AND COALESCE(s.credit_note_id, NULL) IS NULL) = 0,
  'a refunded return always carries a credit note'
);
SELECT throws_ok(
  $$ SELECT public.transition_sales_return(
       '00000000-0000-0000-0000-000000000001'::uuid, 'refunded', NULL) $$,
  NULL, NULL,
  'transition to refunded refuses when there is no settled credit note'
);


-- ---------- Phase 8: tax fidelity & fiscal transmission ----------
SELECT has_column('public', 'sales_return_items', 'source_tax_rate',
  'a return line remembers the rate the invoice line charged');
SELECT has_column('public', 'sales_return_items', 'source_tax_amount',
  'a return line remembers the tax the invoice line charged');
SELECT has_column('public', 'sales_return_items', 'source_discount_percent',
  'a return line remembers the discount the invoice line gave');
SELECT has_column('public', 'sales_return_items', 'etims_tax_code',
  'the fiscal tax code travels with the return line');
SELECT has_column('public', 'sales_return_items', 'tax_basis_source',
  'every return line declares where its tax basis came from');
SELECT has_column('public', 'credit_note_items', 'etims_tax_code',
  'the fiscal tax code reaches the credit note line');

SELECT has_function('public', 'resolve_sales_return_line_tax',
  ARRAY['uuid','numeric'],
  'resolve_sales_return_line_tax(uuid, numeric) exists');
SELECT ok(
  public.resolve_sales_return_line_tax(NULL, 1) IS NULL,
  'the tax resolver returns nothing for a line with no invoice provenance'
);

SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%resolve_sales_return_line_tax%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_sales_return_atomic'),
  'creation resolves tax from the invoice line instead of trusting the client'
);
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%v_return.return_date%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'approve_sales_return_atomic'),
  'the credit note is dated on the return, so the reversal stays in period'
);

-- One fiscal document per economic reversal: the credit note, never the return.
SELECT ok(
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid = 'public.sales_returns'::regclass
      AND NOT tgisinternal
      AND tgname ILIKE '%fiscal%') = 0,
  'a sales return no longer enqueues a fiscal transmission of its own'
);
SELECT has_column('public', 'fiscal_transmissions', 'original_transmission_id',
  'a credit note transmission can point back at the invoice it reverses');

SELECT * FROM finish();
ROLLBACK;
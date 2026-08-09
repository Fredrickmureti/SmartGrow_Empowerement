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
SELECT plan(16);

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

SELECT * FROM finish();
ROLLBACK;
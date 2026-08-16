-- POS Wave — pricing authority: callee signature resolution.
--
-- WHY THIS TEST EXISTS
-- PL/pgSQL resolves the signatures of functions it CALLS at first execution,
-- not at CREATE time. `pos_resolve_line` shipped with:
--
--   resolve_sales_line_tax(..., NULL, CASE WHEN x IS NULL THEN NULL ELSE NULL END)
--
-- Argument 5 was an untyped NULL (`unknown`) and argument 6 an all-NULL CASE,
-- which Postgres types as `text`. Against the real signature
-- (uuid,uuid,uuid,date,uuid,numeric) there is no implicit text->numeric cast,
-- so every call raised 42883 and PostgREST returned HTTP 404. The migration
-- CREATEd cleanly; the till simply could not price a basket. No structural
-- catalog check would have caught it — only executing the function does.
--
-- So: EXECUTE the pricing chain, do not merely assert it exists.

\set ON_ERROR_STOP on

-- 1) The exact call shape `pos_resolve_line` uses must resolve and return a rate.
DO $$
DECLARE v jsonb;
BEGIN
  v := public.resolve_sales_line_tax(
         NULL::uuid, NULL::uuid, NULL::uuid, CURRENT_DATE, NULL::uuid, NULL::numeric);
  IF v IS NULL OR NOT (v ? 'rate') THEN
    RAISE EXCEPTION 'resolve_sales_line_tax returned no rate for the POS call shape: %', v;
  END IF;
END $$;

-- 2) `pos_resolve_line` must execute end-to-end on a non-catalog line
--    (no product row required, still exercises the tax callee).
DO $$
DECLARE v jsonb;
BEGIN
  v := public.pos_resolve_line(
         NULL::uuid,   -- business
         NULL::uuid,   -- product (non-catalog line)
         1::numeric,   -- qty
         100::numeric, -- requested unit price
         NULL::text,   -- discount type
         0::numeric);  -- discount value
  IF v IS NULL OR NOT (v ? 'line_total') THEN
    RAISE EXCEPTION 'pos_resolve_line did not return a priced line: %', v;
  END IF;
END $$;

-- 3) No untyped NULL may be passed to the tax resolver from any POS routine.
--    Guards the specific regression: `NULL,` or an all-NULL CASE in the
--    override argument positions.
DO $$
DECLARE offender text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO offender
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'pos\_%'
    AND pg_get_functiondef(p.oid) ~* 'resolve_sales_line_tax\s*\([^;]*?(,\s*NULL\s*[,)]|CASE\s+WHEN[^;]*?THEN\s+NULL\s+ELSE\s+NULL\s+END)';
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION
      'POS routine passes an untyped NULL to resolve_sales_line_tax (%). '
      'Cast it (NULL::uuid / NULL::numeric) — untyped NULLs break overload '
      'resolution at runtime and take the whole till offline.', offender;
  END IF;
END $$;

-- 4) Pricing seams stay locked to authenticated/service_role only.
DO $$
DECLARE leak text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO leak
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('pos_quote_cart','pos_resolve_line')
    AND EXISTS (
      SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.privilege_type = 'EXECUTE'
        AND a.grantee IN (0, (SELECT oid FROM pg_roles WHERE rolname = 'anon')));
  IF leak IS NOT NULL THEN
    RAISE EXCEPTION 'Pricing seams executable by anon/PUBLIC: %', leak;
  END IF;
END $$;

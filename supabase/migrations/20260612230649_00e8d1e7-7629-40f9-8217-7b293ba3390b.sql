
-- Function-based rollup: bottom-up weighted aggregation in a single pass.
CREATE OR REPLACE FUNCTION public._compute_goal_rollup()
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  cycle_id uuid,
  parent_goal_id uuid,
  alignment text,
  title text,
  weight numeric,
  own_progress numeric,
  rolled_progress numeric,
  subtree_depth int,
  child_weight_sum numeric,
  child_count int,
  weight_sum_warning boolean,
  is_orphan boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  r record;
  rolled numeric;
  cws numeric;
  cc int;
  depth int;
BEGIN
  -- Process deepest-first so children are computed before parents.
  -- Approximate depth via parent chain length (cap at 10 levels).
  FOR r IN
    WITH RECURSIVE chain AS (
      SELECT g.id, g.parent_goal_id, 1 AS lvl
      FROM public.performance_goals g
      WHERE g.parent_goal_id IS NULL
      UNION ALL
      SELECT g.id, g.parent_goal_id, c.lvl + 1
      FROM public.performance_goals g
      JOIN chain c ON g.parent_goal_id = c.id
      WHERE c.lvl < 10
    )
    SELECT g.id, g.organization_id, g.cycle_id, g.parent_goal_id, g.alignment,
           g.title, g.weight, g.progress_pct::numeric AS pp,
           COALESCE((SELECT MAX(lvl) FROM chain x WHERE x.id = g.id), 1) AS lvl
    FROM public.performance_goals g
    ORDER BY COALESCE((SELECT MAX(lvl) FROM chain x WHERE x.id = g.id), 1) DESC
  LOOP
    SELECT SUM(COALESCE(c.weight,0)), COUNT(*) INTO cws, cc
    FROM public.performance_goals c WHERE c.parent_goal_id = r.id;

    IF cc IS NULL OR cc = 0 THEN
      rolled := r.pp;
    ELSE
      -- Use already-computed children from the temp accumulator if present
      SELECT CASE
               WHEN SUM(COALESCE(c.weight,0)) > 0
                 THEN SUM(COALESCE(t.rolled, c.progress_pct::numeric) * COALESCE(c.weight,0)) / SUM(COALESCE(c.weight,0))
               ELSE AVG(COALESCE(t.rolled, c.progress_pct::numeric))
             END
        INTO rolled
        FROM public.performance_goals c
        LEFT JOIN _goal_rollup_acc t ON t.gid = c.id
        WHERE c.parent_goal_id = r.id;
    END IF;

    INSERT INTO _goal_rollup_acc(gid, rolled) VALUES (r.id, rolled);

    id := r.id;
    organization_id := r.organization_id;
    cycle_id := r.cycle_id;
    parent_goal_id := r.parent_goal_id;
    alignment := r.alignment;
    title := r.title;
    weight := r.weight;
    own_progress := ROUND(r.pp, 1);
    rolled_progress := ROUND(rolled, 1);
    subtree_depth := r.lvl;
    child_weight_sum := COALESCE(cws, 0);
    child_count := COALESCE(cc, 0);
    weight_sum_warning := CASE
      WHEN cc IS NULL OR cc = 0 THEN NULL
      WHEN ABS(COALESCE(cws,0) - 100) < 0.5 THEN false
      ELSE true
    END;
    is_orphan := (r.alignment = 'individual' AND r.parent_goal_id IS NULL);
    RETURN NEXT;
  END LOOP;
END;
$$;

-- We need a temp accumulator table-like; use a TEMP TABLE wrapped via a wrapper function.
-- Simpler: redefine using a CTE wrapper that doesn't need temp state.

DROP FUNCTION public._compute_goal_rollup();

-- Pure-SQL function using recursive CTE walking parent->child, then aggregating bottom-up via UPDATE on a temp result set.
CREATE OR REPLACE FUNCTION public.f_goal_alignment_rollup()
RETURNS TABLE (
  id uuid,
  organization_id uuid,
  cycle_id uuid,
  parent_goal_id uuid,
  alignment text,
  title text,
  weight numeric,
  own_progress numeric,
  rolled_progress numeric,
  subtree_depth int,
  child_weight_sum numeric,
  child_count int,
  weight_sum_warning boolean,
  is_orphan boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _goal_rollup_tmp (
    gid uuid PRIMARY KEY, rolled numeric, depth int
  ) ON COMMIT DROP;
  DELETE FROM _goal_rollup_tmp;

  -- First compute depth via top-down recursion
  INSERT INTO _goal_rollup_tmp(gid, rolled, depth)
  WITH RECURSIVE chain AS (
    SELECT g.id AS gid, g.progress_pct::numeric AS rolled, 1 AS depth
    FROM public.performance_goals g
    WHERE g.parent_goal_id IS NULL
    UNION ALL
    SELECT g.id, g.progress_pct::numeric, c.depth + 1
    FROM public.performance_goals g
    JOIN chain c ON g.parent_goal_id = c.gid
    WHERE c.depth < 10
  )
  SELECT gid, rolled, MAX(depth) FROM chain GROUP BY gid, rolled;

  -- Insert orphans (no parent and not a root we visited)
  INSERT INTO _goal_rollup_tmp(gid, rolled, depth)
  SELECT g.id, g.progress_pct::numeric, 1
  FROM public.performance_goals g
  WHERE NOT EXISTS (SELECT 1 FROM _goal_rollup_tmp t WHERE t.gid = g.id);

  -- Bottom-up aggregation: iterate from deepest to root
  FOR r IN
    SELECT t.gid, t.depth
    FROM _goal_rollup_tmp t
    WHERE EXISTS (SELECT 1 FROM public.performance_goals c WHERE c.parent_goal_id = t.gid)
    ORDER BY t.depth DESC
  LOOP
    UPDATE _goal_rollup_tmp SET rolled = (
      SELECT CASE
        WHEN SUM(COALESCE(c.weight,0)) > 0
          THEN SUM(t2.rolled * COALESCE(c.weight,0)) / SUM(COALESCE(c.weight,0))
        ELSE AVG(t2.rolled)
      END
      FROM public.performance_goals c
      JOIN _goal_rollup_tmp t2 ON t2.gid = c.id
      WHERE c.parent_goal_id = r.gid
    )
    WHERE gid = r.gid;
  END LOOP;

  RETURN QUERY
  SELECT
    g.id,
    g.organization_id,
    g.cycle_id,
    g.parent_goal_id,
    g.alignment,
    g.title,
    g.weight,
    ROUND(g.progress_pct::numeric, 1) AS own_progress,
    ROUND(COALESCE(t.rolled, g.progress_pct::numeric), 1) AS rolled_progress,
    COALESCE(t.depth, 1) AS subtree_depth,
    COALESCE(cw.s, 0) AS child_weight_sum,
    COALESCE(cw.n, 0) AS child_count,
    CASE
      WHEN COALESCE(cw.n,0) = 0 THEN NULL
      WHEN ABS(COALESCE(cw.s,0) - 100) < 0.5 THEN false
      ELSE true
    END AS weight_sum_warning,
    (g.alignment = 'individual' AND g.parent_goal_id IS NULL) AS is_orphan
  FROM public.performance_goals g
  LEFT JOIN _goal_rollup_tmp t ON t.gid = g.id
  LEFT JOIN (
    SELECT parent_goal_id, SUM(COALESCE(weight,0))::numeric AS s, COUNT(*)::int AS n
    FROM public.performance_goals
    WHERE parent_goal_id IS NOT NULL
    GROUP BY parent_goal_id
  ) cw ON cw.parent_goal_id = g.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.f_goal_alignment_rollup() TO authenticated;

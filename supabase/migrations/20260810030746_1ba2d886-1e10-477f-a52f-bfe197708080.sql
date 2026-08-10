CREATE OR REPLACE VIEW public.dunning_assignment
WITH (security_invoker = true) AS
SELECT np.organization_id,
       np.business_id,
       np.branch_id,
       np.contact_id,
       np.contact_name,
       np.net_amount,
       np.max_days_overdue,
       CASE WHEN dsp.disputed_amount > 0 THEN NULL ELSE lvl.id END AS dunning_level_id,
       CASE WHEN dsp.disputed_amount > 0 THEN NULL ELSE lvl.name END AS dunning_level_name,
       CASE WHEN dsp.disputed_amount > 0 THEN NULL ELSE lvl.sequence END AS dunning_sequence,
       CASE WHEN dsp.disputed_amount > 0 THEN NULL ELSE lvl.action_type END AS next_action,
       CASE WHEN dsp.disputed_amount > 0 THEN NULL ELSE lvl.template_id END AS template_id,
       COALESCE(dsp.disputed_amount, 0) AS disputed_amount,
       COALESCE(dsp.disputed_amount, 0) > 0 AS on_hold
  FROM public.finance_ar_net_position np
  LEFT JOIN LATERAL (
        SELECT d.id, d.name, d.sequence, d.action_type, d.template_id
          FROM public.dunning_levels d
         WHERE d.organization_id = np.organization_id
           AND d.active
           AND (d.business_id IS NULL OR d.business_id = np.business_id)
           AND np.max_days_overdue >= d.min_days_overdue
         ORDER BY (d.business_id IS NOT NULL) DESC, d.min_days_overdue DESC, d.sequence DESC
         LIMIT 1
  ) lvl ON true
  LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(x.base_amount_disputed), 0) AS disputed_amount
          FROM public.ar_disputes x
         WHERE x.organization_id = np.organization_id
           AND x.business_id = np.business_id
           AND x.contact_id = np.contact_id
           AND x.status = 'open'
  ) dsp ON true
 WHERE np.net_amount > 0.01;

GRANT SELECT ON public.dunning_assignment TO authenticated;

CREATE OR REPLACE VIEW public.collections_work_queue
WITH (security_invoker = true) AS
WITH pos AS (
  SELECT np.organization_id,
         np.business_id,
         np.contact_id,
         MAX(np.contact_name) AS contact_name,
         SUM(np.net_amount) AS net_amount,
         SUM(np.not_due) AS not_due,
         SUM(np.current_bucket) AS current_bucket,
         SUM(np.days30) AS days30,
         SUM(np.days60) AS days60,
         SUM(np.days90) AS days90,
         MAX(np.max_days_overdue) AS max_days_overdue
    FROM public.finance_ar_net_position np
   GROUP BY np.organization_id, np.business_id, np.contact_id
  HAVING SUM(np.net_amount) > 0.01
)
SELECT p.organization_id,
       p.business_id,
       p.contact_id,
       p.contact_name,
       p.net_amount,
       p.not_due,
       p.current_bucket,
       p.days30,
       p.days60,
       p.days90,
       p.max_days_overdue,
       ca.collector_user_id,
       lvl.id AS dunning_level_id,
       lvl.name AS dunning_level_name,
       lvl.action_type AS next_action,
       ptp.id AS promise_id,
       ptp.promised_amount,
       ptp.expected_payment_date,
       COALESCE(dsp.disputed_amount, 0) AS disputed_amount,
       (COALESCE(dsp.disputed_amount, 0) > 0) AS in_dispute,
       (ptp.id IS NOT NULL) AS in_promise,
       ROUND(
         p.net_amount
         * (1 + GREATEST(p.max_days_overdue, 0)::numeric / 30)
         * CASE WHEN COALESCE(dsp.disputed_amount, 0) > 0 THEN 0.25
                WHEN ptp.id IS NOT NULL THEN 0.5
                ELSE 1 END
       , 2) AS priority_score
  FROM pos p
  LEFT JOIN public.collector_assignments ca
    ON ca.organization_id = p.organization_id
   AND ca.contact_id = p.contact_id
   AND ca.active
  LEFT JOIN LATERAL (
        SELECT d.id, d.name, d.action_type
          FROM public.dunning_levels d
         WHERE d.organization_id = p.organization_id
           AND d.active
           AND (d.business_id IS NULL OR d.business_id = p.business_id)
           AND p.max_days_overdue >= d.min_days_overdue
         ORDER BY (d.business_id IS NOT NULL) DESC, d.min_days_overdue DESC, d.sequence DESC
         LIMIT 1
  ) lvl ON true
  LEFT JOIN LATERAL (
        SELECT t.id, t.promised_amount, t.expected_payment_date
          FROM public.ar_promises_to_pay t
         WHERE t.organization_id = p.organization_id
           AND t.business_id = p.business_id
           AND t.contact_id = p.contact_id
           AND t.status = 'open'
         ORDER BY t.expected_payment_date ASC
         LIMIT 1
  ) ptp ON true
  LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(x.base_amount_disputed), 0) AS disputed_amount
          FROM public.ar_disputes x
         WHERE x.organization_id = p.organization_id
           AND x.business_id = p.business_id
           AND x.contact_id = p.contact_id
           AND x.status = 'open'
  ) dsp ON true;

GRANT SELECT ON public.collections_work_queue TO authenticated;

CREATE OR REPLACE FUNCTION public.get_collections_work_queue(
  _business_id uuid,
  _collector_user_id uuid DEFAULT NULL
)
RETURNS SETOF public.collections_work_queue
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT *
    FROM public.collections_work_queue q
   WHERE q.business_id = _business_id
     AND (_collector_user_id IS NULL OR q.collector_user_id = _collector_user_id)
   ORDER BY q.priority_score DESC
   LIMIT 500;
$$;

REVOKE ALL ON FUNCTION public.get_collections_work_queue(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_collections_work_queue(uuid, uuid) TO authenticated, service_role;
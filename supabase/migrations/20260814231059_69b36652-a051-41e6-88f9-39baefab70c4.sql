CREATE OR REPLACE VIEW public.wms_operator_board_view AS
 SELECT o.id AS operator_id,
    o.business_id,
    o.warehouse_id,
    o.user_id,
    o.employee_id,
    o.operator_code,
    o.status,
    o.status_changed_at,
    o.is_active,
    o.home_zone_id,
    o.equipment_classes,
    o.max_concurrent_tasks,
    TRIM(BOTH ' '::text FROM (COALESCE(e.first_name, ''::text) || ' '::text) || COALESCE(e.last_name, ''::text)) AS operator_name,
    e.employee_number,
    ( SELECT count(*) AS count
           FROM wms_tasks t
          WHERE t.assignee_user_id = o.user_id AND t.warehouse_id = o.warehouse_id AND (t.state::text = ANY (ARRAY['assigned'::text, 'claimed'::text, 'in_progress'::text, 'paused'::text, 'resumed'::text]))) AS open_tasks,
    ( SELECT COALESCE(sum(t.earned_seconds), 0::numeric) AS "coalesce"
           FROM wms_tasks t
          WHERE t.assignee_user_id = o.user_id AND t.warehouse_id = o.warehouse_id AND t.state::text = 'done'::text AND t.completed_at >= date_trunc('day'::text, now())) AS earned_seconds_today,
    ( SELECT COALESCE(sum(t.actual_seconds), 0::numeric) AS "coalesce"
           FROM wms_tasks t
          WHERE t.assignee_user_id = o.user_id AND t.warehouse_id = o.warehouse_id AND t.state::text = 'done'::text AND t.completed_at >= date_trunc('day'::text, now())) AS actual_seconds_today,
    o.row_version
   FROM wms_operators o
     LEFT JOIN employees e ON e.id = o.employee_id;
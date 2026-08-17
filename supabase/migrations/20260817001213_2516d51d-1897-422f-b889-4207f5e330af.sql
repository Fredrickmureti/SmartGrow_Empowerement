
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, handler_scope, description)
VALUES
 ('warehouse.count.recorded','warehouse', ARRAY['warehouse','inventory'],'server','A cycle/physical count line was recorded in the warehouse.'),
 ('warehouse.labour.gap_detected','warehouse', ARRAY['warehouse'],'server','Labour plan detected a staffing gap against forecast workload.'),
 ('warehouse.labour.plan_published','warehouse', ARRAY['warehouse'],'server','A labour plan was published for a shift.'),
 ('warehouse.lpn.moved','warehouse', ARRAY['warehouse','inventory'],'server','A licence plate (handling unit) was moved between locations.'),
 ('warehouse.task.assigned','warehouse', ARRAY['warehouse'],'server','A warehouse task was assigned to an operator.'),
 ('warehouse.task.available','warehouse', ARRAY['warehouse'],'server','A warehouse task was released back to the queue.'),
 ('warehouse.trailer.arrived','warehouse', ARRAY['warehouse'],'server','A trailer arrived at the yard.'),
 ('warehouse.trailer.departed','warehouse', ARRAY['warehouse'],'server','A trailer departed the yard.'),
 ('warehouse.trailer.docked','warehouse', ARRAY['warehouse'],'server','A trailer was docked at a door.'),
 ('warehouse.trailer.no_show','warehouse', ARRAY['warehouse'],'server','A booked trailer failed to arrive.'),
 ('warehouse.yard.checked_in','warehouse', ARRAY['warehouse'],'server','A yard visit was checked in at the gate.'),
 ('warehouse.yard.departed','warehouse', ARRAY['warehouse'],'server','A yard visit departed the site.'),
 ('warehouse.yard.docked','warehouse', ARRAY['warehouse'],'server','A yard visit was assigned to a dock.'),
 ('warehouse.yard.no_show','warehouse', ARRAY['warehouse'],'server','A yard appointment was marked as a no-show.')
ON CONFLICT (topic_prefix) DO NOTHING;

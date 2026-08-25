INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description, handler_scope, integration_only)
VALUES
  ('projects.', 'projects', ARRAY['finance','analytics','notifications'],
   'Project delivery lifecycle: milestones reached, reopened and invoiced.', 'server', false),
  ('projects.milestone.reached', 'projects', ARRAY['finance','notifications'],
   'A project milestone has been marked reached and may become billable.', 'server', false),
  ('projects.milestone.reopened', 'projects', ARRAY['finance','notifications'],
   'A previously reached, uninvoiced project milestone was reopened.', 'server', false),
  ('projects.milestone.invoiced', 'projects', ARRAY['finance','analytics','notifications'],
   'A project milestone has been billed to a draft customer invoice.', 'server', false)
ON CONFLICT (topic_prefix) DO NOTHING;
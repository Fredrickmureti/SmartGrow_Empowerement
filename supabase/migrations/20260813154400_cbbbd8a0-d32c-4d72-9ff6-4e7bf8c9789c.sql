INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, description, handler_scope)
VALUES ('landed_cost.', 'procurement', ARRAY['finance','inventory','analytics'],
        'Landed cost voucher lifecycle: allocation, posting, reversal.', 'server')
ON CONFLICT (topic_prefix) DO NOTHING;
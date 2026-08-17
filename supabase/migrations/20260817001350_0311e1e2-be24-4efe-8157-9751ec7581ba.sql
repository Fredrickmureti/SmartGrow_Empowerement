
INSERT INTO public.business_event_topics (topic_prefix, producer_domain, consumer_domains, handler_scope, description)
VALUES
 ('purchase_return.draft','purchasing', ARRAY['purchasing','inventory'],'server','A purchase return was drafted.'),
 ('purchase_return.submitted','purchasing', ARRAY['purchasing','inventory'],'server','A purchase return was submitted for approval.'),
 ('purchase_return.approved','purchasing', ARRAY['purchasing','inventory','finance'],'server','A purchase return was approved.'),
 ('purchasing.purchase_return.created','purchasing', ARRAY['purchasing','inventory'],'server','A purchase return was created (domain-prefixed alias).'),
 ('purchasing.purchase_return.submitted','purchasing', ARRAY['purchasing','inventory'],'server','A purchase return was submitted (domain-prefixed alias).'),
 ('purchasing.purchase_return.approved','purchasing', ARRAY['purchasing','inventory','finance'],'server','A purchase return was approved (domain-prefixed alias).'),
 ('procurement.grn.received','procurement', ARRAY['procurement','inventory','finance'],'server','A goods receipt note was recorded against an inbound shipment.'),
 ('warehouse.receiving.discrepant','warehouse', ARRAY['warehouse','procurement'],'server','A receiving session was flagged discrepant against its expectation.'),
 ('warehouse.receiving.closed','warehouse', ARRAY['warehouse'],'server','A receiving session was closed.')
ON CONFLICT (topic_prefix) DO NOTHING;

-- New views (finance_ar_customer_credit, finance_ar_net_position) and the
-- replaced AR functions must be visible to PostgREST immediately, otherwise the
-- API answers 404/PGRST202 for objects that already exist.
NOTIFY pgrst, 'reload schema';
-- The audit/reporting role could not read finance_ar_net_position because the
-- membership guard inside it was not executable. The function only answers
-- "is this user in this org?", so PUBLIC execute leaks nothing.
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) TO PUBLIC;
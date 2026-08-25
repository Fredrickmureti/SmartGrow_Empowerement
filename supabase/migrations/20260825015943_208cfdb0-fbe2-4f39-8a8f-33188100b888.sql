-- Trigger-only helper: nobody should be able to invoke it through the API.
REVOKE ALL ON FUNCTION public._crm_lead_currency_default() FROM PUBLIC, anon, authenticated;
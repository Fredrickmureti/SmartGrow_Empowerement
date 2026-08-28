CREATE OR REPLACE FUNCTION public._consolidation_cta_account_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_acc public.accounts;
  v_ga  public.consolidation_group_accounts;
BEGIN
  IF NEW.cta_account_id IS NOT NULL THEN
    SELECT * INTO v_acc FROM public.accounts a WHERE a.id = NEW.cta_account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The translation adjustment account does not exist' USING ERRCODE = '23514';
    END IF;
    IF v_acc.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'The translation adjustment account belongs to another organization' USING ERRCODE = '23514';
    END IF;
    IF v_acc.business_id IS DISTINCT FROM NEW.parent_business_id THEN
      RAISE EXCEPTION 'The translation adjustment account must belong to the parent company of the group' USING ERRCODE = '23514';
    END IF;
    IF v_acc.account_type <> 'equity'::public.account_type THEN
      RAISE EXCEPTION 'The translation adjustment must be carried in an equity account, not a % account', v_acc.account_type USING ERRCODE = '23514';
    END IF;
    IF COALESCE(v_acc.is_header, false) THEN
      RAISE EXCEPTION 'The translation adjustment account must be a postable account, not a heading' USING ERRCODE = '23514';
    END IF;
    IF NOT COALESCE(v_acc.is_active, true) THEN
      RAISE EXCEPTION 'The translation adjustment account is archived' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- The reserve is a group construct: where the group keeps its own chart it
  -- must be presented on a group account, never on a member's equity account.
  IF NEW.cta_group_account_id IS NOT NULL THEN
    SELECT * INTO v_ga FROM public.consolidation_group_accounts ga WHERE ga.id = NEW.cta_group_account_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The group translation reserve account does not exist' USING ERRCODE = '23514';
    END IF;
    IF v_ga.group_id <> NEW.id THEN
      RAISE EXCEPTION 'The group translation reserve account belongs to another consolidation group' USING ERRCODE = '23514';
    END IF;
    IF v_ga.account_type <> 'equity'::public.account_type THEN
      RAISE EXCEPTION 'The group translation reserve must be an equity group account, not a % account', v_ga.account_type USING ERRCODE = '23514';
    END IF;
    IF NOT v_ga.is_active THEN
      RAISE EXCEPTION 'The group translation reserve account is inactive' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;
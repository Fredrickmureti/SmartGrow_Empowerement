CREATE OR REPLACE FUNCTION public.log_payroll_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_entity_type TEXT := TG_ARGV[0];
  v_entity_name TEXT;
  v_old JSONB := NULL;
  v_new JSONB := NULL;
  v_summary TEXT;
  v_org_id UUID;
  v_action TEXT;
BEGIN
  IF TG_TABLE_NAME = 'payroll_runs' THEN
    v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_name := COALESCE(NEW.payroll_number, OLD.payroll_number);
    IF TG_OP = 'UPDATE' THEN
      v_old := jsonb_build_object('status', OLD.status, 'posted_at', OLD.posted_at,
                                  'approved_at', OLD.approved_at, 'reversed_at', OLD.reversed_at);
      v_new := jsonb_build_object('status', NEW.status, 'posted_at', NEW.posted_at,
                                  'approved_at', NEW.approved_at, 'reversed_at', NEW.reversed_at);
      v_summary := COALESCE(OLD.status, '∅') || ' → ' || COALESCE(NEW.status, '∅');
    ELSE
      v_new := jsonb_build_object('status', NEW.status, 'pay_period_start', NEW.pay_period_start,
                                  'pay_period_end', NEW.pay_period_end);
      v_summary := 'created (' || COALESCE(NEW.status, 'draft') || ')';
    END IF;
  ELSIF TG_TABLE_NAME = 'payslips' THEN
    v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_name := COALESCE(NEW.payslip_number, OLD.payslip_number, NEW.id::text);
    v_old := jsonb_build_object('status', OLD.status, 'paid_at', OLD.paid_at);
    v_new := jsonb_build_object('status', NEW.status, 'paid_at', NEW.paid_at);
    v_summary := COALESCE(OLD.status, '∅') || ' → ' || COALESCE(NEW.status, '∅');
  ELSIF TG_TABLE_NAME = 'payroll_liabilities' THEN
    v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_name := COALESCE(NEW.rule_code, OLD.rule_code) || ' ' ||
                     to_char(COALESCE(NEW.period_start, OLD.period_start), 'YYYY-MM');
    v_old := jsonb_build_object('status', OLD.status, 'paid_amount', OLD.paid_amount,
                                'outstanding_amount', OLD.outstanding_amount);
    v_new := jsonb_build_object('status', NEW.status, 'paid_amount', NEW.paid_amount,
                                'outstanding_amount', NEW.outstanding_amount);
    v_summary := COALESCE(OLD.status, '∅') || ' → ' || COALESCE(NEW.status, '∅') ||
                 ' (paid ' || COALESCE(OLD.paid_amount, 0)::text || ' → ' || COALESCE(NEW.paid_amount, 0)::text || ')';
  ELSIF TG_TABLE_NAME = 'payroll_remittance_payments' THEN
    v_org_id := COALESCE(NEW.organization_id, OLD.organization_id);
    v_entity_name := COALESCE(NEW.reference_number, OLD.reference_number,
                              COALESCE(NEW.authority_name, OLD.authority_name) || ' ' ||
                              to_char(COALESCE(NEW.payment_date, OLD.payment_date), 'YYYY-MM-DD'));
    IF TG_OP = 'UPDATE' THEN
      v_old := jsonb_build_object('status', OLD.status, 'reversed_at', OLD.reversed_at,
                                  'journal_entry_id', OLD.journal_entry_id);
      v_new := jsonb_build_object('status', NEW.status, 'reversed_at', NEW.reversed_at,
                                  'journal_entry_id', NEW.journal_entry_id);
      v_summary := COALESCE(OLD.status, '∅') || ' → ' || COALESCE(NEW.status, '∅');
    ELSE
      v_new := jsonb_build_object('status', NEW.status, 'total_amount', NEW.total_amount,
                                  'journal_entry_id', NEW.journal_entry_id);
      v_summary := 'recorded (' || COALESCE(NEW.status, 'posted') || ', ' || NEW.total_amount::text || ')';
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  v_action := CASE TG_OP
    WHEN 'INSERT' THEN 'created'
    WHEN 'UPDATE' THEN 'updated'
    WHEN 'DELETE' THEN 'deleted'
  END;

  INSERT INTO public.audit_logs (
    organization_id, user_id, action, entity_type, entity_id, entity_name,
    old_values, new_values, changes_summary
  ) VALUES (
    v_org_id, auth.uid(),
    v_action,
    v_entity_type, COALESCE(NEW.id, OLD.id), v_entity_name,
    v_old, v_new, v_summary
  );

  RETURN NEW;
END;
$$;
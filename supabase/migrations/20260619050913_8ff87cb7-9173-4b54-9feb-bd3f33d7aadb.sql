create or replace function public.hr_notify_loan_event(
  _loan_id uuid,
  _event text,
  _actor uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_loan record;
  v_emp record;
  v_org uuid;
  v_biz uuid;
  v_kind text;
  v_amount text;
  v_num text;
  v_title text;
  v_message text;
  v_type text;
  v_priority int;
  v_link text;
  v_notices jsonb := '[]'::jsonb;
  v_recip uuid;
  r record;
begin
  if _loan_id is null or _event is null then
    return v_notices;
  end if;

  select * into v_loan from public.employee_loans where id = _loan_id;
  if not found then
    return v_notices;
  end if;

  v_org := v_loan.organization_id;
  v_biz := v_loan.business_id;

  select e.id, e.first_name, e.last_name, e.user_id, e.manager_id
    into v_emp
  from public.employees e
  where e.id = v_loan.employee_id;

  v_kind := case when v_loan.loan_type = 'advance' then 'Salary advance' else 'Loan' end;
  v_amount := to_char(coalesce(v_loan.principal_amount, 0), 'FM999,999,999,990.00');
  v_num := case when v_loan.loan_number is not null then ' (' || v_loan.loan_number || ')' else '' end;

  if _event = 'loan.requested' then
    -- INBOUND: payroll approvers + the employee's direct manager.
    v_title := v_kind || ' request' || v_num;
    v_message := coalesce(trim(v_emp.first_name || ' ' || v_emp.last_name), 'An employee')
      || ' requested a ' || lower(v_kind) || ' of ' || v_amount
      || '. Review and approve in Payroll → Loans.';

    for r in
      select distinct ur.user_id
      from public.user_roles ur
      where ur.organization_id = v_org
        and ur.is_active = true
        and ur.user_id is not null
        and public.user_has_module_permission(ur.user_id, v_org, 'payroll', 'write')
    loop
      v_recip := r.user_id;
      if _actor is not null and v_recip = _actor then continue; end if;
      perform public.create_notification(
        v_org, v_recip, 'info', 'loan', v_title, v_message,
        '/hr/payroll/loans', 'employee_loan', v_loan.id, 1, v_biz
      );
      v_notices := v_notices || jsonb_build_object(
        'user_id', v_recip, 'category', 'loan', 'title', v_title, 'message', v_message,
        'link', '/hr/payroll/loans', 'entity_type', 'employee_loan',
        'entity_id', v_loan.id, 'business_id', v_biz
      );
    end loop;

    -- Manager (if linked to a user and not already an approver / actor).
    if v_emp.manager_id is not null then
      select e.user_id into v_recip from public.employees e where e.id = v_emp.manager_id;
      if v_recip is not null
         and (_actor is null or v_recip <> _actor)
         and not (v_notices @> jsonb_build_array(jsonb_build_object('user_id', v_recip))) then
        perform public.create_notification(
          v_org, v_recip, 'info', 'loan', v_title, v_message,
          '/hr/payroll/loans', 'employee_loan', v_loan.id, 1, v_biz
        );
        v_notices := v_notices || jsonb_build_object(
          'user_id', v_recip, 'category', 'loan', 'title', v_title, 'message', v_message,
          'link', '/hr/payroll/loans', 'entity_type', 'employee_loan',
          'entity_id', v_loan.id, 'business_id', v_biz
        );
      end if;
    end if;

  else
    -- OUTBOUND: notify the employee.
    if v_emp.user_id is null then
      return v_notices;
    end if;
    v_recip := v_emp.user_id;

    if _event = 'loan.approved' then
      v_title := v_kind || ' approved' || v_num;
      v_message := 'Your ' || lower(v_kind) || ' of ' || v_amount
        || ' has been approved. Monthly deduction: '
        || to_char(coalesce(v_loan.monthly_deduction, 0), 'FM999,999,999,990.00') || '.';
      v_type := 'success'; v_priority := 0;
    elsif _event = 'loan.rejected' then
      v_title := v_kind || ' rejected' || v_num;
      v_message := case
        when v_loan.rejection_reason is not null and length(trim(v_loan.rejection_reason)) > 0
          then 'Your ' || lower(v_kind) || ' request of ' || v_amount
               || ' was rejected. Reason: ' || v_loan.rejection_reason
        else 'Your ' || lower(v_kind) || ' request of ' || v_amount
             || ' was rejected. Please contact HR for details.'
      end;
      v_type := 'error'; v_priority := 1;
    elsif _event = 'loan.disbursed' then
      v_title := v_kind || ' disbursed' || v_num;
      v_message := 'Your ' || lower(v_kind) || ' of ' || v_amount || ' has been disbursed.';
      v_type := 'success'; v_priority := 0;
    else
      return v_notices;
    end if;

    v_link := '/me/loans';
    perform public.create_notification(
      v_org, v_recip, v_type, 'loan', v_title, v_message,
      v_link, 'employee_loan', v_loan.id, v_priority, v_biz
    );
    v_notices := v_notices || jsonb_build_object(
      'user_id', v_recip, 'category', 'loan', 'title', v_title, 'message', v_message,
      'link', v_link, 'entity_type', 'employee_loan',
      'entity_id', v_loan.id, 'business_id', v_biz
    );
  end if;

  return v_notices;
end;
$function$;

grant execute on function public.hr_notify_loan_event(uuid, text, uuid) to authenticated;
grant execute on function public.hr_notify_loan_event(uuid, text, uuid) to service_role;
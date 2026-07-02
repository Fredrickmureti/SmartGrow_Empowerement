TRUNCATE TABLE
  public.organizations,
  public.businesses,
  public.branches,
  public.user_roles,
  public.user_business_access,
  public.user_active_business,
  public.user_branch_assignments,
  public.member_permission_groups,
  public.notifications,
  public.notification_preferences,
  public.notification_alert_settings,
  public.notification_digest_queue,
  public.login_history,
  public.dashboard_spreadsheet_pins,
  public.admin_audit_log,
  public.admin_sent_emails,
  public.audit_logs,
  public.identity_drift_reports,
  public.accounting_integrity_reports
RESTART IDENTITY CASCADE;

DO $$
BEGIN
  RAISE NOTICE 'orgs=%, biz=%, branches=%, user_roles=%, contacts=%, invoices=%, journal_entries=%',
    (SELECT count(*) FROM public.organizations),
    (SELECT count(*) FROM public.businesses),
    (SELECT count(*) FROM public.branches),
    (SELECT count(*) FROM public.user_roles),
    (SELECT count(*) FROM public.contacts),
    (SELECT count(*) FROM public.invoices),
    (SELECT count(*) FROM public.journal_entries);
END $$;
/**
 * Business-scoped tables registry.
 *
 * Every table listed here carries a `business_id` column and represents
 * data that belongs to a single Company within a Workspace. Application
 * queries against any of these tables MUST filter by BOTH:
 *   - `.eq("organization_id", currentOrg.id)`   (workspace gate)
 *   - `.eq("business_id",     currentBusiness.id)` (company gate)
 *
 * Filtering by organization alone leaks data across companies in the same
 * workspace and contaminates the books — see Phase A/B of the
 * Zero-Trust Architecture Audit for the full rationale.
 *
 * The architecture test `src/test/architecture/business-scoped-queries.test.ts`
 * scans every `.from("<table>")` call against this registry and fails the
 * build if `business_id` is absent from the same query chain.
 *
 * If you legitimately need cross-company data (admin tooling, consolidation,
 * audit-log review across all companies in a workspace), add the marker
 * comment   // SCOPE-EXEMPT: <short reason>
 * within 200 chars BEFORE the `.from(...)` call. The arch test honors it.
 */
export const BUSINESS_SCOPED_TABLES = [
  // Books / accounting
  "accounts",
  "journal_entries",
  "journal_entry_lines",
  "fiscal_periods",
  "default_account_settings",
  "accounting_integrity_reports",
  // AR
  "invoices",
  "invoice_items",
  "credit_notes",
  "customer_statements",
  "payments",
  "customer_groups",
  // AP
  "bills",
  "bill_payments",
  "purchase_orders",
  // Sales
  "sales_orders",
  "backorders",
  // Inventory
  "products",
  "warehouses",
  "stock_movements",
  // Tax
  "tax_rates",
  "tax_groups",
  // Banking
  "bank_accounts",
  "bank_reconciliation_sessions",
  "bank_statements",
  // Contacts
  "contacts",
  // CRM
  "crm_leads",
  "crm_activities",
  "crm_activity_types",
  "crm_lost_reasons",
  "crm_stages",
  // HR / Payroll  (note: `leave_types` is workspace-scoped on purpose — HR
  // policy catalogs are shared org-wide. `leave_requests` IS company-scoped.)
  "employees",
  "departments",
  "attendance",
  "leave_requests",
  "timesheets",
  "timesheet_submissions",
  "work_schedules",
  "payroll_runs",
  // POS  (note: `pos_manager_overrides` is workspace-scoped on purpose —
  // operational override audit trail is workspace-wide.)
  "pos_sessions",
  "pos_shifts",
  "pos_floors",
  "pos_registers",
  "pos_transactions",
  "pos_manager_pins",
  // Assets
  "fixed_assets",
  "asset_categories",
  "asset_maintenance",
  // Documents / branding
  "document_templates",
  "organization_payment_methods",
  "organization_payment_gateways",
  // Budgets
  "budgets",
  // Analytic
  "analytic_accounts",
  "analytic_distributions",
  "analytic_groups",
  // Approvals / automation  (note: `approval_requests` and `approval_rules`
  // are workspace-scoped — approval policy applies workspace-wide.
  // `approval_workflows` IS company-scoped.)
  "approval_workflows",
  "automated_actions",
  // Audit / AI
  "audit_logs",
  "ai_insights_cache",
  // ── Phase B additions (architecture audit, 2026-04) ──
  // POS state + config (was org-only, now company-scoped + branch-aware)
  "pos_settings",
  "pos_tables",
  "pos_cashiers",
  "pos_security_settings",
  "pos_discounts",
  "pos_happy_hours",
  "pos_kitchen_orders",
  "pos_modifier_groups",
  "pos_modifiers",
  "pos_split_bills",
  "pos_table_sessions",
  "pos_courses",
  "pos_held_transactions",
  "pos_table_bookings",
  "pos_table_transfers",
  // pos_stock_reservations dropped (Phase 4). POS holds live on the
  // unified stock_reservations table (source_type='pos').
  "pos_cash_movements",
  "pos_approval_requests",
  "pos_gift_cards",
  "pos_gift_card_transactions",
  // Payroll / HR (res.company)
  "salary_components",
  "payroll_statutory_rules",
  // payroll_rule_types is a workspace-level catalog (like leave_types) — no business_id.
  "benefit_plans",
  "leave_types",
  "public_holidays",
  "timesheet_settings",
  "employee_documents",
  "employee_field_configs",
  "employee_onboarding",
  "employee_statutory_identifiers",
  "onboarding_templates",
  // Tax / Compliance
  "tax_compliance_configs",
  "tax_report_templates",
  "etims_tax_categories",
  "etims_transmission_logs",
  "mpesa_c2b_transactions",
  // Inventory
  "warehouse_stock",
  "stock_transfers",
  "product_categories",
  "promotions",
  // Reporting & automation
  "scheduled_reports",
  "saved_views",
  "report_saved_views",
  "report_generation_logs",
  "automated_action_logs",
  "transaction_categorization_rules",
  "depreciation_schedules",
  // NOTE: `approval_requests`, `approval_rule_logs`, `approval_rules` are
  // intentionally workspace-scoped (see comment block higher in this file).
  // Do NOT add them here — `business_id` is nullable and remains NULL by
  // design so a workspace-wide approval policy applies across all companies.
  // Documents / signing (Documents app retired 2026-05-16; signing kept)
  "signature_requests",
  "signature_templates",
  "document_comments",
  "document_emails",
  // Settings / communication
  "payment_provider_configs",
  "notification_preferences",
  "notification_digest_queue",
  "sms_templates",
  "sms_event_rules",
  "sms_opt_outs",
  "organization_api_integrations",
  // AR/AP supporting
  "vendor_credit_note_applications",
  "vendor_portal_invitations",
  "project_tasks",
  // ── Phase 2 additions (Zero-Trust audit, 2026-04) ──
  "pos_waitlist",
  "report_field_configs",
  "automation_execution_tracker",
  "dashboard_spreadsheet_pins",
  "spreadsheet_pivots",
  "spreadsheet_global_filters",
  "spreadsheet_validation_rules",
  "core_field_overrides",
  "entity_field_values",
  "form_layouts",
  // NOTE: `permission_groups` and `member_permission_groups` are
  // workspace-scoped (Odoo `res.groups` semantics) — verified empirically:
  // 0% of rows carry a business_id. Filtering by business would silently
  // empty the page in any multi-company workspace. Do NOT add them here.
  // ── Phase 1 sweep additions (Zero-Trust audit, 2026-04) ──
  // These tables already have a `business_id` column in the schema and are
  // genuinely company-scoped — they were just missing from the registry.
  "expenses",
  "expense_categories",
  "estimates",
  "email_templates",
  "bank_transactions",
  "vendor_pricelists",
  "pos_payment_methods",
  // NOTE: `permission_group_rules` is FK-bound to `permission_groups` which
  // is workspace-scoped — also workspace-scoped, do NOT add to this registry.
  // ── Purchases sweep additions (Zero-Trust audit, 2026-04, Batch 3) ──
  // These purchases-domain tables already carry business_id (and most
  // branch_id) in the DB schema. The actual hooks query them with the
  // correct org+business filter, but the architecture test wasn't
  // enforcing it for these table names — closing that gap now so the
  // next dev can't accidentally introduce a leaky query.
  "vendor_credit_notes",
  "purchase_returns",
  "rfqs",
  "goods_receipts",
] as const;

export type BusinessScopedTable = (typeof BUSINESS_SCOPED_TABLES)[number];

export function isBusinessScopedTable(name: string): name is BusinessScopedTable {
  return (BUSINESS_SCOPED_TABLES as readonly string[]).includes(name);
}
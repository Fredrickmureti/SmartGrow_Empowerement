# 14 · Glossary & Data Dictionary

## Glossary

| Term | Meaning |
|---|---|
| **Pack** | Localization Pack — a versioned bundle of country rules, identifiers, GL templates, statutory document templates |
| **Run** | A single payroll execution (`payroll_runs` row); types are `regular | off_cycle | bonus | commission | 13th_month | termination | supplemental | correction` |
| **Readiness** | Fail-closed gate that blocks payroll runs until configuration is complete |
| **Rule set** | Immutable snapshot of salary structure rules used by the engine (byte-identical recompute) |
| **Statutory rule** | A pack-seeded row in `payroll_statutory_rules` with a `computation_method` |
| **Liability** | An amount owed to a statutory authority — single source of truth in `payroll_liabilities` |
| **Remittance** | Payment of a liability to an authority |
| **JE** | Journal Entry (general-ledger transaction) |
| **SoD** | Separation of Duties — DB-trigger framework blocking self-actions on sensitive surfaces |
| **PII** | Personally identifiable information; masked via `v_employees_safe` and `get_employee_pii` |
| **Portal user** | An employee with `role='portal', user_type='portal'`, restricted to `/me/*` |
| **Internal user** | Staff with `user_type='internal'` (`owner | admin | super_admin | hr | finance | etc.`) |
| **Branding** | Per-org logo + colors loaded by `getOrganizationBranding` for documents |
| **Self-service bypass** | Edge-function shortcut allowing employee to download their own document without `payroll.read` |
| **Drift** | Mismatch between GL balance and sub-ledger balance for a control account |

## Data dictionary (compact)

> Fields listed are the **domain-specific** ones only. Standard fields (`id`, `organization_id`, `business_id`, `branch_id`, `created_at`, `updated_at`, `created_by`, `updated_by`) are omitted.

### HR / Employee
- **employees** — `email`, `hire_date`, `termination_date`, `is_active`, `lifecycle_status`, `user_id`, `user_access_status`, `employee_number`, `employment_type`, `job_position_id`, `work_location_id`, `department_id`, `manager_id`, `statutory_country_code`, `bank_*`.
- **employments** — `start_date`, `end_date`, `status`, `termination_type`, `termination_reason`, `is_primary`.
- **employee_position_history** — `effective_from`, position/department/manager/branch + `prev_*`, `change_reason`, `changed_by`.
- **employee_contracts** — `status`, `wage`, `housing_allowance`, `transport_allowance`, `other_allowances`, `salary_structure_id`, `time_tracking_source`, `working_schedule`, `start_date`, `end_date`, `probation_end_date`, `contract_reference`, `approved_at/by`, `submitted_at/by`.
- **contract_compensation_components** — `component_code`, `label`, `amount`, `recurrence`, `taxable`, `effective_from/to`.
- **employee_compensation_history** — `effective_date`, `basic_salary`, `allowances_json`, `change_type`, `reason`, `source_contract_id`, `approved_at/by`, `submitted_at/by`, `currency_code`.
- **employee_documents** — `document_type`, `name`, `file_path`, `file_name`, `file_size`, `mime_type`, `uploaded_by`, `expiry_date`, `is_verified`, `verified_by/at`, `acknowledged_by/at`.
- **employee_credentials** — `kiosk_pin_hash` (kiosk PIN only; not portal password).
- **employee_statutory_identifiers** — `identifier_type`, `identifier_value`.
- **employee_onboarding** / `_items` — `status`, `onboarding_type`, `template_id`, `started_at`, `completed_at`; item: `category`, `completed_at`, `is_required`.
- **onboarding_templates** / `_items` — `name`, `template_type`, `is_default`; item: `title`, `category`, `assigned_role`, `sort_order`, `is_required`.
- **hr_policies** — `probation_period_months`, `notice_period_days`, `leave_year_start_month`, `employee_number_format`, `employee_number_next_seq`, `default_onboarding_template_id`, `default_offboarding_template_id`, `retire_age`.
- **departments** — `name`, `manager_id`, `parent_department_id`.
- **job_positions** — `title`, `department_id`, `is_active`, `expected_headcount`.
- **work_locations** — `name`, `location_type`, address.
- **organization_invitations** — `token`, `email`, `role`, `user_type`, `permission_group_ids`, `expires_at`, `accepted_at`, `invited_by`.
- **onboarding_attempts** — `user_id`, `status`, `diagnostics`, `idempotency_key`.

### Talent / Performance / Training
- **performance_cycles** — `name`, period, `state`.
- **performance_goals** — `employee_id`, target, status.
- **performance_reviews** — `cycle_id`, `employee_id`, `reviewer_id`, `state`, ratings.
- **calibration_sessions**, **review_*** — review template + responses.
- **competencies**, **competency_assessments**, **competency_scales**, **competency_role_requirements**, **employee_competencies**.
- **succession_plans**, **successors**, **talent_pools**, **talent_pool_members**, **talent_potential_ratings**.
- **merit_recommendations** — recommended pay change per employee per cycle.
- **training_courses**, **training_enrollments**, **training_course_materials**, **learning_paths**, **learning_path_courses**, **learning_path_enrollments**.
- **quiz_questions**, **quiz_attempts**.

### Attendance / Leave / Timesheets / Shifts
- **attendance** — `clock_in/out`, `status`, `source`, `locked`, anomaly flags.
- **attendance_breaks** — `break_type ∈ {rest, meal, other}`.
- **attendance_corrections** — `status`, proposed_*, `reviewed_by`.
- **attendance_events** — raw event stream.
- **attendance_devices** — `vendor`, `serial`, `public_id`, `hmac_secret`, `status`, `last_seen_at`.
- **attendance_device_trust** — per-device-per-employee trust.
- **attendance_ingest_log** — `payload_hash` (replay-dedup).
- **attendance_settings** — `auto_checkout_after_hours`, `geofence_required`, `selfie_required`, `device_binding_required`, `enforce_shift_window`, `block_clock_in_on_approved_leave`, `require_ot_preapproval`, `impossible_travel_action`.
- **leave_requests** — `status`, `days_requested`, `start/end_date`, `start/end_period`, `first/second_approver_id`.
- **leave_allocations** — period balance per employee/type.
- **leave_types** — `code`, `max_days_per_request`, accrual.
- **public_holidays** — date, scope.
- **timesheets** — `date`, `hours`, `start/end_time`, `project_id`, `task_id`, `is_billable`, `billing_rate`, `payroll_locked`, `is_invoiced`, `correction_of`.
- **timesheet_submissions** — week aggregate.
- **timesheet_audit_log** — `action`.
- **timesheet_settings** — config.
- **shifts** — template (`start_time`, `end_time`, `break_minutes`, `paid_break`, `crosses_midnight`, `night_differential_pct`).
- **shift_assignments** — `assignment_date`, `status`, `source`, `published_at`.
- **shift_swap_requests** — requester/target + status.
- **overtime_requests** — `ot_date`, `requested_hours`, `status`.
- **work_schedules**, **work_schedule_days** — defined but unconsumed.

### Payroll
- **payroll_runs** — `status`, `run_type`, totals, `rule_set_id/hash`, `is_reversal`, `parent_run_id`, `reclassification_journal_entry_id`.
- **payroll_run_groups** — multi-company grouping.
- **payroll_run_issues** — `severity`, `code`, `message`.
- **payroll_run_loan_skip_overrides** — per-run pause override.
- **payroll_periods**, **pay_schedules** — period + cadence.
- **payslips** — header (`gross_pay`, `total_deductions`, `net_pay`, `taxable_income`, `rule_set_version/hash`, `retro_of_payslip_id`).
- **payslip_lines** — `rule_code`, `rule_type`, `category`, `label`, `employee_amount`, `employer_amount`, `taxable`, `sequence`, `source`, `rule_version_id/hash` (authoritative line ledger).
- **payslip_inputs** — provenance (hours, proration factor, overrides).
- **payroll_salary_rules** — `code`, `sequence`, `category`, `condition_select`, `amount_select`, `statutory_rule_id`.
- **salary_components** — legacy flat components.
- **salary_structures** — `use_structure_engine` flag.
- **salary_structure_rule_sets** — immutable rule snapshot (`components`, `version`, `rule_hash`).
- **payroll_work_entries** — `hours`, `overtime_hours`, `holiday_hours`, `attendance_count`, `source`.
- **payroll_work_entry_types** — `is_paid`, `counts_as_worked`, `multiplier_normal/overtime`.
- **payroll_readiness_rules** / `_findings` / `_runs` / `_rule_overrides` — fail-closed gate model.
- **payroll_employee_ytd** — YTD accumulator.
- **retro_pay_adjustments** — queue of delta payslips.
- **employee_garnishments** — `cap_rule`, `priority`, `kind`, `aggregate_cap_exempt`, `total_owed/paid`.
- **garnishment_kind_defaults** — kind policy.
- **employee_loans** — `repayment_method`, `paused_until`, `min_net_pay_floor`, `max_pct_of_net`, `outstanding_balance`, `loan_type_id`.
- **loan_types** — `code`, `salary_rule_code`, `gl_receivable_account_id`, `gl_disbursement_clearing_account_id`.
- **loan_repayments**, **loan_repayment_schedule** — installment ledger.
- **payroll_settings** — garnishment policy + `payslip_show_employer_statutory_ids`.
- **payroll_liabilities** — `authority_name`, `label`, `country_code`, `period_start/end`, `due_date`, `original_amount`, `paid_amount`, `outstanding_amount`, `status`, `liability_account_id`.
- **payroll_liability_sources** — links payslip contributions to a liability.
- **payroll_remittances** — legacy mirror.
- **payroll_remittance_payments** / `_allocations` — payment header + allocation lines.
- **payroll_tax_certificates** — `template_code`, `template_pack_id`, `fiscal_year`, `payload`, `pdf_path`, `serial_number`, `status`.
- **payroll_certificate_template_overrides** — per-org tweaks to certificate templates.
- **payroll_return_runs** — `template_code`, `template_pack_id`, period, `payload`, `csv_path`, `pdf_path`, `serial_number`, `status`.
- **payroll_return_template_overrides** — per-org tweaks to return templates.
- **payroll_reclassification_audit** — ADR-0022 reclassification log.
- **je_number_sequences** — JE number counters per org.
- **payroll_payment_batches** / `_items` — net-pay disbursement.

### Localization
- **localization_packs** — `country_code`, `name`, `version`, `is_active`, `is_published`, `tokens_inherit_platform`.
- **pack_versions** — `version`, `status`, `snapshot`, `changelog`, `parent_version_id`, `published_by`.
- **pack_requirements** — `identifier_key`, `required`.
- **pack_rule_type_schemas** — `rule_type`, `computation_kind`, `schema_version`, `json_schema`, `ui_schema`, `token_outputs`.
- **pack_token_registry** — `token_path`, `source`, `data_type`, `deprecated_in_version`.
- **pack_audit_log** — entity, action, before, after.
- **pack_upgrade_proposals** — `from_version`, `to_version`, `diff`, `status`.
- **installed_localization_packs** — `pack_id`, `pack_version`, `installed_by`, `status`.
- **localization_pack_account_templates** — `code`, `account_type`, `parent_code`, `is_system`.
- **localization_pack_certificate_templates** — `rule_code`, `body`.
- **localization_pack_payroll_templates** — `rule_type`, `rule_name`, `computation_method`, `parameters`.
- **localization_pack_remittance_schedules** — `rule_code`, `frequency`, `authority_name`.
- **localization_pack_return_templates** — `rule_code`, `body`.
- **localization_pack_tax_templates** — `name`, `rate`, `is_compound`, `is_inclusive`.
- **pack_account_roles** — `rule_code`, `role_key`.

### Statutory identity & catalog
- **country_statutory_catalog** — master identifier types per country.
- **organization_statutory_identifiers** — employer registration numbers.

### Finance / GL (read by payroll)
- **accounts** — chart of accounts.
- **journal_entries**, **journal_entry_lines** — GL postings.
- **default_account_settings** — payroll role → account_id mapping (trigger-guarded).
- **default_account_mapping_audit** — change log.
- **control_account_drift_log** — daily drift snapshot (append-only).
- **finance_alert_drift_streaks** — streak counter for escalation.
- **fiscal_periods** — period lock.
- **bank_accounts** — disbursement source.

### Governance / SoD
- **self_action_policy** — `(org, action_key, mode, applies_to_role)`.
- **self_action_overrides** — co-signed, one-hour, single-use.
- **audit_logs** — every governance action recorded.

### Notifications & messaging
- **notifications** — in-app rows.
- **notification_preferences** / `_alert_settings` / `_digest_queue` — per-user channel prefs.
- **email_event_outbox**, **sms_event_outbox** — outbound queues.

### Identity
- **profiles** — user-level fields (email, full_name, avatar).
- **user_roles** — `role`, `user_type`, `organization_id`.
- **member_permission_groups** — group membership.
- **permission_groups** / `_rules` — module + can_* matrix.

> For exact column types and policies, run `supabase--read_query` against `information_schema.columns` and `pg_policies` for the table in question.

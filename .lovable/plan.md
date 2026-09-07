# Settings Domain Reconstruction — Kenyan Microfinance

Audit date: 2026-09-07. Scope: Settings domain only. Loans, Payments/Settlement, Accounting, Reports and Access Groups are **not** redesigned — they are only touched where Settings depends on them.

---

## 0. Audit Summary

### 0.1 Live database reality (verified against the running DB, not migrations)

- No `pos_*`, `invoice*`, `product*`, `inventory*`, `payroll*`, `warehouse*` tables exist any more. Migrations still reference them historically, but the objects are gone.
- Residual legacy commercial tables that DO still exist and are empty: `sales_orders`, `sales_order_items`, `sales_returns`, `sales_return_items`, `sales_return_cost_basis`, `sales_document_idempotency`, `payment_requests` (0 rows), `mpesa_c2b_transactions` (0 rows).
- Microfinance is the live domain: `mf_clients` (4), `mf_loans` (6), `accounts` (108), `bank_accounts` (1).
- Currency: `currencies` and `business_active_currencies` contain **only KES**.
- `branch_overridable_settings` holds 6 keys (`receipt_header`, `receipt_footer`, `contact_email`, `contact_phone`, `document_logo_url`, `document_address`); `branch_setting_overrides` is **empty**.
- `document_templates` and `email_templates` are **empty**.

### 0.2 Critical defect found (blocking, fix first)

`public.get_effective_company_config(p_business_id, p_branch_id)` still selects `biz.invoice_prefix`, `biz.estimate_prefix`, `biz.bill_prefix` and `branches.default_warehouse_id`. **None of those columns exist any more** (dropped in `20260907093125`). The function therefore raises at runtime for every call.

Callers:
- `supabase/functions/_shared/branding/getOrganizationBranding.ts:127`
- `supabase/functions/generate-document/index.ts:107`

Consequence: any branch-scoped document branding resolution fails. This is Wave 1 and everything else queues behind it.

### 0.3 Settings surface inventory

Hubs: `/settings/workspace` (org-scoped) and `/settings/company` (business-scoped, behind `CompanyScopeGate`), plus standalone routes registered in `src/App.tsx:185-194`. Nav lives in `src/apps/platform/nav.ts`.

---

## 1. Classification of every setting

Verdicts: **RETAIN** (correct as-is) / **ADAPT** (keep concept, rework for Kenyan MFI) / **REPLACE** (concept valid, implementation wrong) / **REMOVE** (ERP contamination) / **DEFER** (out of this wave).

### Workspace hub (`src/pages/settings/WorkspaceSettings.tsx`)

| Setting | Surface | Verdict | Rationale |
|---|---|---|---|
| Profile | `profiles` | RETAIN | User identity, domain-neutral. |
| Appearance / theme | `ThemeSettings.tsx`, `next-themes`, no backend | RETAIN | Client preference only. |
| Workspace name | `organizations.name` | RETAIN | Legitimate org-level config. |
| Notifications | `EnhancedNotificationSettings.tsx`, `notification_preferences`, `notification_alert_settings` | ADAPT | Keep channel prefs in Settings; retarget event catalogue to MFI events (repayment due/overdue, disbursement, approval). Delivery logic stays in the notification domain. |
| Security (PIN, devices, login history) | `SecuritySettings.tsx`, `user_pins`, `user_devices`, `login_history`, `security_alerts`, `user_security_preferences` | RETAIN | Session security, not a second RBAC model. |
| Access Groups | `AccessGroups.tsx` | RETAIN | Central RBAC — the only permission model. No Settings-local permissions. |
| Governance / SoD | `GovernanceModeCard.tsx`, `SelfActionPolicy.tsx`, `BlockedAttemptsQueue.tsx`, `self_action_policy`, `governance_action_registry` | RETAIN | Maker–checker is core to a lender. |
| Email delivery provider | `EmailProviderSettings.tsx`, `get/set_email_provider_settings` | RETAIN | Real infrastructure config. |

### Company hub (`src/pages/settings/CompanySettings.tsx`)

| Setting | Surface | Verdict | Rationale |
|---|---|---|---|
| Business + branch CRUD | `BusinessBranchSettings.tsx`, `BusinessLogoUpload.tsx` | RETAIN | Institution + branch network is MFI master data. |
| Branch overrides engine | `BranchConfiguration.tsx`, `branch_overridable_settings`, `branch_setting_overrides`, `set_branch_setting`, `clear_branch_setting`, `resolve_branch_setting` | RETAIN (repair) | Sound inheritance architecture; whitelist must be re-scoped to MFI keys. |
| Effective config resolver | `get_effective_company_config` | REPLACE | Currently broken (dropped columns). Rewrite around MFI keys only. |
| Bank accounts | `BranchOperations.tsx`, `bank_accounts`, `bank_account_update` | ADAPT | Bank accounts are **finance master data**, not Settings. Settings keeps only the *selection* of which account backs a payment channel. |
| Currency | `CurrencySettings.tsx`, `FxRateCoverageCard.tsx`, `change_business_base_currency`, `set_business_active_currency`, `set_exchange_rate_override` | ADAPT | KES-only verdict: lock base currency to KES and hide FX/multi-currency UI. Keep the underlying multi-currency tables (accounting already references them) but remove the user-facing switch. |
| M-Pesa provider (STK/C2B) | `MpesaProviderCard.tsx`, `MpesaC2BProviderCard.tsx`, `payment_provider_configs`, edge fns `mpesa-c2b`/`mpesa-callback`/`mpesa-outbound` | ADAPT | Core Kenyan channel. Restrict to **PayBill**; drop `CustomerBuyGoodsOnline` (Till). |
| Stripe gateway | `PaymentGatewaySettings.tsx`, `usePaymentGateway.ts`, `organization_payment_gateways`, vault RPCs | REMOVE | No international card acquiring in a Kenyan MFI. |
| Payments debugger | `PaymentsDebugger.tsx`, `payment_requests` | DEFER | Keep as internal diagnostics until M-Pesa rework lands, then re-point or delete. |
| Payment methods (display) | `PaymentMethodsSettings.tsx`, `AddPaymentMethodDialog.tsx`, `organization_payment_methods`, enum `payment_method_type` | REPLACE | Replace the generic bank/mobile_money/online/cash/**crypto** catalogue with a fixed MFI **payment channel** model: Cash, M-Pesa PayBill, Bank Transfer/Deposit. |
| Crypto payment methods | `src/types/paymentMethod.ts`, enum value `crypto`, BTC/ETH/USDT/USDC | REMOVE | Hard constraint. |
| Online/PayPal/Wise/Payoneer/Venmo/CashApp | `src/types/paymentMethod.ts` | REMOVE | Not Kenyan MFI channels. |
| POS terminal providers (`pos_terminal_provider`: `stripe_terminal`, `adyen`, `verifone`, `square_terminal`) | enum only | REMOVE | Orphan enum, zero consumers. |
| Email sender identity | inline `EmailSettingsForm` → `businesses.email_display_name`, `email_reply_to` | RETAIN | Legitimate. |
| Email templates | `EmailTemplateEditor.tsx`, `email_templates`, `ensure_default_email_templates` | ADAPT | Keep, but fix the key set to MFI events only (`loan_approved`, `loan_disbursed`, `repayment_receipt`, `repayment_reminder`, `repayment_overdue`). |
| Document templates | `DocumentTemplateSettings.tsx`, `DocumentTemplateBuilder.tsx`, `useDocumentTemplates.ts`, `document_templates`, `templateRenderer.ts` | REMOVE | See §2. |
| Document numbering | no UI today | REPLACE | See §3. |

---

## 2. Document templates verdict

Findings:
- The canonical engine is `render-document` → `resolveTemplateAst` (`document_kinds`, `document_template_ast`, `document_theme`, `document_header_footer`, `document_records`, `document_artifacts`, `document_print_policies`), with **body layout hard-coded in TypeScript** per `kind_code` (`supabase/functions/_shared/pdf/layouts/lending.ts`: loan agreement, repayment schedule, loan statement, payment receipt, client statement). A runtime guard rejects any AST declaring a layout with no registered renderer.
- `document_templates` is a **second, older, parallel system** read only by `_shared/templateRenderer.ts`. It offers show/hide toggles and free-text header/footer. Its own type docstring admits cosmetic styling is hardcoded server-side. The table is **empty in production**.

Decision: **Remove the user-editable template surface; keep the document-generation engine intact.** Microfinance documents are statutory/contractual — they must be standardised with server-side data injection, not user-editable. Removing `document_templates` also removes the ambiguity of two renderers disagreeing.

Kept: `document_kinds`, `document_template_ast`, `document_theme`, `document_header_footer`, `document_records`, `document_artifacts`, `document_print_policies`, `render-document`, all `pdf/layouts/*`.
Removed: `DocumentTemplateSettings.tsx`, `DocumentTemplateBuilder.tsx`, `PaymentMethodSelector.tsx`, `useDocumentTemplates.ts`, `src/types/documentTemplate.ts`, the `document_templates` table, `businesses.show_payment_methods_on_documents`, and the `document_templates` branch of `templateRenderer.ts`.
Branding (logo, address, contact, receipt header/footer) survives via `getOrganizationBranding.ts` + the repaired effective-config resolver — that is the only user-controllable document surface that remains.

---

## 3. Document numbering verdict

Current state: ~35 `get_next_*_number` functions survive; almost all are ERP/warehouse/HR (`invoice`, `estimate`, `bill`, `po`, `rfq`, `grn`, `asn`, `wave`, `carton`, `manifest`, `employee`, `leave_request`, `project`, `task`, `lead`, `asset`, `draft_transaction`, `opening_stock`, `adjustment`, `recall_reference`, `contract_reference`, `sales_return`, `so`, `credit_note`, `proforma`, `delivery`, `receipt`, `expense`). Only `get_next_journal_entry_number` has a live accounting consumer. There is **no** MFI numbering UI and no `get_next_loan_number` in the live DB.

Decision: introduce one generic, concurrency-safe sequence service scoped organization → branch, with a Settings UI for prefixes/format only.

Target objects:
- `document_number_sequences(id, organization_id, business_id, branch_id NULL, sequence_key, prefix, padding, period_reset, current_value, updated_at)` with a unique index on `(organization_id, business_id, coalesce(branch_id,'…'), sequence_key, period_key)`.
- `sequence_key` domain: `loan`, `loan_application`, `client`, `branch`, `repayment`, `receipt`, `disbursement`.
- `get_next_number(p_org, p_business, p_branch, p_key)` — `pg_advisory_xact_lock` on a hash of the scope key, increment-then-return, gap-tolerant (gaps allowed and documented; numbers are never reused).
- All changes to prefix/format recorded in the existing audit log; `current_value` is never user-editable.

---

## 4. Effective-value resolution

Deterministic order, unchanged conceptually, repaired in implementation:

```text
branch_setting_overrides  ->  business (businesses row)  ->  organization default  ->  none
```

New MFI whitelist for `branch_overridable_settings` (replacing the ERP prefix keys already deleted):
`receipt_header`, `receipt_footer`, `contact_email`, `contact_phone`, `document_logo_url`, `document_address`, `mpesa_paybill_number`, `default_bank_account_id`, plus per-branch numbering prefixes for `loan`, `receipt`, `disbursement`.
Never overridable: base currency, tax identity, chart-of-accounts mappings, fiscal year, RBAC.

---

## 5. Payment channels

Target model (`organization_payment_channels`, replacing `organization_payment_methods`):

| Channel | Config | Notes |
|---|---|---|
| Cash | active flag, GL cash account | Branch-scoped. |
| M-Pesa PayBill | paybill (shortcode), account-reference convention, credentials in vault, reconciliation account, active flag | Till (`CustomerBuyGoodsOnline`) not retained — an MFI collects to a PayBill with the loan/client number as account reference. |
| Bank Transfer / Deposit | `bank_account_id` FK into `bank_accounts`, active flag | Bank account records stay finance master data; Settings only selects and activates. |

Removed enum values/types: `crypto`, `online`, `pos_terminal_provider`, Stripe/Flutterwave/Paystack/PayPal/Pesapal provider literals.

---

## 6. Waves

Each wave is independently shippable and reversible.

### Wave 1 — Repair the effective-config resolver (blocking)
- **Objective**: make `get_effective_company_config` executable again.
- **Current state**: references `businesses.invoice_prefix|estimate_prefix|bill_prefix` and `branches.default_warehouse_id`; all dropped.
- **Decision**: rewrite the function to return only surviving keys: `logo_url`, `document_address`, `contact_email`, `contact_phone`, `receipt_header`, `receipt_footer`, `base_currency`, `tax_id`, `fiscal_year_start`, `timezone`.
- **Files**: `supabase/functions/_shared/branding/getOrganizationBranding.ts`, `supabase/functions/generate-document/index.ts`.
- **DB**: `CREATE OR REPLACE FUNCTION public.get_effective_company_config`.
- **Migration order**: replace function → regenerate types → verify callers.
- **Tests**: call the RPC for every business with and without a branch; render one loan agreement and one repayment receipt.
- **Acceptance**: no runtime error; branded PDF still carries logo/address/contact.
- **Risk**: a caller depends on a removed key. **Rollback**: re-create the previous definition (it is already non-functional, so rollback is safe).

### Wave 2 — Remove Stripe and crypto
- **Objective**: eliminate non-Kenyan payment configuration.
- **Files**: delete `PaymentGatewaySettings.tsx`, `usePaymentGateway.ts`; strip `stripe`/`flutterwave`/`paystack` from `usePaymentProviders.ts`; strip crypto/online types from `src/types/paymentMethod.ts`; remove crypto branches in `AddPaymentMethodDialog.tsx`, `PaymentMethodsSettings.tsx`, `_shared/pdfGenerator.ts:592`, `_shared/templateRenderer.ts:157`; remove the Stripe branch of `supabase/functions/provider-test/index.ts`.
- **DB**: drop `organization_payment_gateways`, `set_payment_gateway_secret`, `delete_payment_gateway_secret`; purge vault entries; drop enum value `crypto` (via type recreation) and the `pos_terminal_provider` type.
- **Migration order**: frontend removal → edge-function removal → RPC drop → table drop → enum recreation.
- **Tests**: settings page renders; no `stripe`/`crypto` matches in `src/` or `supabase/functions/`.
- **Acceptance**: no crypto or card-acquiring concept exists anywhere.
- **Risk**: enum recreation touches dependent columns — do it inside one transaction with explicit `ALTER TABLE ... TYPE ... USING`.

### Wave 3 — Payment channels (Cash / M-Pesa PayBill / Bank Transfer) — REVISED VERDICT
- **Objective**: MFI channel vocabulary on the existing catalogue.
- **Decision (supersedes the original)**: do NOT create `organization_payment_channels`. `organization_payment_methods` is already narrowed to `cash | mobile_money | bank`, already FKs `bank_accounts`, and already carries `branch_id`. Adapt it in place; a parallel table buys nothing and risks a data migration for cosmetic gain.
- **Files**: `PaymentMethodsSettings.tsx`, `AddPaymentMethodDialog.tsx`, `usePaymentMethods.ts`, `MpesaC2BProviderCard.tsx`, `src/types/paymentMethod.ts`.
- **Status**: type/label narrowing done; Till removed from M-Pesa C2B settings (PayBill only, config always `shortcode_type: "paybill"`).
- **Acceptance**: exactly three channel kinds configurable; Till is unavailable anywhere in Settings.

### Wave 4 — KES-only currency
- **Objective**: lock the institution to KES.
- **Files**: `CurrencySettings.tsx`, `FxRateCoverageCard.tsx`.
- **Decision**: hide base-currency change, active-currency management and FX override UI; keep `currencies`, `business_active_currencies` and the FX tables because accounting still joins them.
- **DB**: revoke/guard `change_business_base_currency` and `set_exchange_rate_override`; add a check that `businesses.base_currency = 'KES'`.
- **Acceptance**: no UI path can produce a non-KES amount; accounting queries unaffected.

### Wave 5 — Remove the document-template builder
- **Objective**: standardise MFI documents.
- **Files**: delete `DocumentTemplateSettings.tsx`, `DocumentTemplateBuilder.tsx`, `PaymentMethodSelector.tsx`, `useDocumentTemplates.ts`, `src/types/documentTemplate.ts`; remove the templates tab from `CompanySettings.tsx`; remove the `document_templates` lookup in `_shared/templateRenderer.ts`.
- **DB**: drop `document_templates` (empty) after confirming `document_template_ast` rows in use key off `kind_code`, not `template_id`.
- **Tests**: render all five lending documents through `render-document`; byte-hash comparison before/after.
- **Acceptance**: documents render identically; no template-editing UI remains; the engine is untouched.
- **Risk**: an AST row still FKs `template_id` — verify and re-key before dropping.

### Wave 6 — Document numbering
- **Objective**: organization/branch numbering for MFI documents.
- **Files**: new `src/components/settings/DocumentNumberingSettings.tsx` + hook; wire loan, application, client, receipt, disbursement creation paths to `get_next_number`.
- **DB**: create `document_number_sequences` + `get_next_number`; seed defaults per organization; add numbering prefixes to `branch_overridable_settings`.
- **Migration order**: table + function → seed → migrate consumers one at a time → UI.
- **Tests**: concurrency test (parallel `get_next_number` calls yield unique, monotonic values); uniqueness constraint violation test; audit-log entry on prefix change.
- **Acceptance**: changing a prefix in Settings changes the next generated loan/receipt number.

### Wave 7 — Notifications and email templates re-scope
- **Objective**: MFI-only event catalogue.
- **Files**: `EnhancedNotificationSettings.tsx`, `EmailTemplateEditor.tsx`.
- **DB**: prune non-MFI rows from `notification_alert_settings`; fix `ensure_default_email_templates` key set.
- **Acceptance**: only lending events are configurable; toggling a channel changes actual delivery.

### Wave 8 — Legacy DB cleanup
- **Objective**: no dead ERP objects behind Settings.
- **DB**: drop the empty legacy commercial tables (`sales_orders`, `sales_order_items`, `sales_returns`, `sales_return_items`, `sales_return_cost_basis`, `sales_document_idempotency`, `payment_requests` if the debugger is deleted) and the ERP `get_next_*_number` functions with no consumers, plus `businesses.credit_note_prefix` / `proforma_prefix`.
- **Guard**: run a consumer grep across `src/` and `supabase/functions/` for each object immediately before dropping.
- **Acceptance**: `information_schema` shows no ERP-only Settings objects; app builds and all tests pass.

---

## 7. Cross-cutting rules

- **Permissions**: all new Settings surfaces gate on existing `usePermissions` flags (`canEditSettings`, `canManageBusiness`, `canManageOrganization`). No new permission model.
- **Audit**: every setting mutation writes to the existing audit-log architecture, including branch override set/clear and numbering prefix changes.
- **Never drop before migrating consumers.** Each wave's drop step is the last step of that wave.

## 8. Execution status

### Completed (Wave 6)
- DB verified in place: `document_number_rules`, `document_number_counters`, `mf_next_number()`, `mf_assign_document_number()` triggers on clients, applications, loans, repayments. The trigger assigns unconditionally — any client-supplied number is overwritten.
- `src/components/settings/DocumentNumberingSettings.tsx` (prefix + padding per document kind, live sample).
- Wired as the "Numbering" tab of `src/pages/settings/CompanySettings.tsx` (gated on `canEditSettings`).
- `ClientFormDialog` / `ApplicationFormDialog`: removed the client-side guessed numbers (`nextClientNumber`, `nextApplicationNumber` no longer used); the reference field is now read-only "Assigned automatically" on create and read-only on edit. `client_number` / `application_number` made optional in `MfClientInput` / `MfLoanApplicationInput` and no longer sent on insert. Unused `existingClients` / `existing` props dropped from both pages.
- `npx tsgo --noEmit` clean.

### Completed (Wave 7) — 2026-09-07
- Verified already-MFI-scoped: `useNotifications` categories (loan/payment/collection/expense/team/system), `EmailTemplateEditor` keys (5 lending templates), `ensure_default_email_templates` (same 5 keys, no ERP templates). No change needed.
- `notification_alert_settings`: dropped ERP columns `low_stock_warning_threshold`, `low_stock_critical_threshold`, `out_of_stock_alert`, `invoice_reminder_days_before`; `upsert_notification_alert_settings` rewritten (SECURITY DEFINER, same authz) without those keys.
- `src/hooks/useNotificationAlertSettings.ts`: interfaces, defaults and Zod schema pruned (critical<=warning refine removed with the fields).
- `src/test/architecture/notification-alert-settings.test.ts` updated; 14 tests pass; `npx tsgo --noEmit` clean.

### Completed (Wave 8, partial)
- Dropped ERP numbering functions with zero DB and zero app consumers: `get_next_rfq_number`, `get_next_lead_number`, `get_next_task_number`, `get_next_project_number`, `get_next_wave_number`, `get_next_manifest_number`, `get_next_carton_number`, `get_next_asn_number`, `get_next_adjustment_number`, `get_next_draft_transaction_number`, `get_next_leave_request_number`.
- Dropped `businesses.credit_note_prefix` and `businesses.proforma_prefix` (referenced only by generated types + a guard test).

### Remaining (Wave 8) — deliberately NOT done, with evidence
- `sales_orders`, `sales_order_items`, `sales_returns`, `sales_return_items`, `sales_return_cost_basis`, `sales_document_idempotency`: all 0 rows, BUT `sales_orders` is referenced by 32 DB functions, `sales_order_items` by 13, `sales_returns` by 12, and `delivery_notes.sales_order_id` / `delivery_note_items.sales_order_item_id` FK into them. Also referenced by `supabase/functions/{generate-document,send-document-email,ai-assistant}` and `src/hooks/{useExport,realtime/useUnifiedRealtimeSync}`. Dropping requires a dedicated delivery-notes/AI-assistant wave — out of Settings scope.
- `payment_requests`: RETAIN. Actively consumed by `supabase/functions/mpesa-outbound` and `mpesa-callback` (live M-Pesa flow), not just the debugger.
- Remaining `get_next_*_number` functions (`invoice`, `estimate`, `credit_note`, `proforma`, `so`, `sales_return`, `receipt`, `expense`, `delivery`, `document`, `employee`, `asset`, `opening_stock`, `journal_entry`) all still have DB callers and/or app callers — each needs its consumer retired first.

### Next action

Here's where things stand.

Fixed this turn

The build error is resolved: the document view no longer imports the two lineage strips that were removed with the sales paperwork.
The audit-log "Clear All" dialog now mounts properly, and two out-of-date code checks were corrected. The project type-checks cleanly.
Background database routines: the automation notifier used by clients, staff and expense records was cleaned up (it also had an old hardcoded link to a previous project, now removed); three unused sales-lineage reports were retired; and the "preview what a company reset would delete" routine was rebuilt around the record types this system actually has.
Still outstanding Seven routines still mention removed tables and would fail if called — none are used by the app today: the company base-currency readiness/change pair, the contact-deletion dependency check, the FX rate coverage report, the sample-data counter, and the reversal-preview helper. Beyond those, a wider sweep found several dozen more orphaned invoice/purchase-order routines inherited from the old ERP; that deserves its own dedicated clean-up wave rather than piecemeal edits. Five remaining check failures are historical migration records and are safe to leave as they are.
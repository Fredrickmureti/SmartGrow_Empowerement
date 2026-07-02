# Settings — Source of Truth & Branch Override Rules

This document is the canonical reference for **where each ERP setting lives**, **which scope can edit it**, and **whether it can be overridden at the branch level**. It is enforced by:

- `branch_overridable_settings` (DB whitelist) — `set_branch_setting` / `clear_branch_setting` will refuse any key not listed.
- `src/test/architecture/branch-overridable-whitelist.test.ts` — fails CI if a future migration adds an accounting-sensitive key.
- `get_effective_company_config` RPC — applies the resolution order below.

## Scope hierarchy (Odoo `res.company` parity)

```
platform / global   ← LOVABLE platform admin only
  ↓
organization        ← tenant (one customer = one organization)
  ↓
business / company  ← legal entity inside the organization (1-to-many; Odoo res.company)
  ↓
branch / location   ← physical site inside the business (1-to-many; Odoo res.branch)
```

A user always operates in **one** organization and **one** business at a time. Branches are operational scoping inside the active business and never cross businesses.

## Setting categories and where they live

| Category | Source of truth | Branch override? | Why |
|---|---|---|---|
| **Tax (rates, IDs, jurisdictions, fiscal mapping)** | `businesses.tax_id` + `tax_rates` table | **NEVER** | Tax is a property of the legal entity, not the location. Allowing branch-level overrides would silently corrupt VAT/sales-tax filings and consolidation. |
| **Currency (base, secondary, FX policy)** | `businesses.base_currency` + `currency_settings` | **NEVER** | The base currency defines the chart-of-accounts denomination. Two branches of the same company cannot disagree. |
| **Chart of Accounts / Journals / Fiscal periods** | `chart_of_accounts`, `journals`, `organizations.fiscalyear_lock_date` | **NEVER** | Accounting integrity. A journal is a property of the legal entity. |
| **Document numbering — invoice / estimate / bill / receipt** | `businesses.invoice_prefix`, `.estimate_prefix`, `.bill_prefix` (+ `branches.invoice_prefix_suffix` for legacy) | **YES** (per branch) | Allows a Nairobi branch to issue `NRB-INV-001` while Mombasa issues `MSA-INV-001`. Sequence-uniqueness is still enforced server-side. |
| **Document branding — logo / address / footer** | `businesses.logo_url`, `.address`, `.city`, `.country` | **YES** (per branch) | A branch may have its own physical address printed on receipts. Falls back to the company's primary business when no override is set. |
| **Branch contact info (email, phone)** | `businesses.email`, `.phone` | **YES** (per branch) | Receipts and emailed invoices route to the branch operations contact when overridden. |
| **POS hardware / register / cash drawers** | `pos_registers`, `pos_devices` (carry `branch_id` directly) | **N/A** | The records themselves are branch-scoped at the FK level — there is no "override". |
| **Inventory locations / warehouses** | `warehouses` (carries `branch_id` directly) | **N/A** | Same — FK-level branch scoping. |
| **HR — payroll structures, leave types** | Org-level (`organizations` + `payroll_structures`) | **NO** | Payroll rules are jurisdiction-bound to the legal entity, not the site. Per-branch employee assignment is handled at the employee record level, not in settings. |
| **Roles, permission groups, access groups** | `user_roles`, `permission_groups`, `member_permission_groups` (org-scoped) | **NO** | Permissions cross branches by design. Per-branch operational scoping is enforced by the row-level `branch_id` filters in queries, not by duplicating roles. |
| **App subscriptions / installed apps / entitlements** | `organization_installed_apps`, `plan_app_access`, `org_entitlement_overrides` | **N/A** | Apps are an organization-wide property of the subscription. |
| **Notifications, email templates** | `email_templates`, `notification_settings` (org-scoped) | **NO** (today) | Could be moved to the whitelist if a customer asks for per-branch templates. Not done by default to keep the resolver lean. |
| **Platform settings (PIN policy, session timeout)** | `platform_settings` (workspace-wide) — columns `setting_key` / `setting_value` | **N/A** | Platform-admin only. Never tenant-editable. |

## Resolution order

For any whitelisted key, `get_effective_company_config(business_id, branch_id)` returns:

```
branch_setting_overrides    ← if a row exists for (branch_id, key)
       ↓ (else)
legacy branches column      ← e.g. branches.logo_url, branches.invoice_prefix_suffix
       ↓ (else)
businesses column           ← the company default (canonical for tax/currency/journals)
       ↓ (else)
NULL                        ← surface as "no value" in the UI; never silently pick a global default
```

The returned object includes a `source` field per key (`'branch_override' | 'branch' | 'business' | null`) so the UI can show provenance and the audit log can record where a printed value came from.

## Adding a new branch-overridable setting

1. Add a row to `branch_overridable_settings` via a migration (NOT a runtime insert — runtime inserts are blocked).
2. Confirm the key is **not** an accounting-sensitive key (the architecture test will fail CI if it is).
3. Extend `get_effective_company_config` to surface the new key in its returned JSON.
4. Update `docs/settings-consumers.md` with the new key and its consumers.
5. The BranchConfiguration UI (`src/components/settings/BranchConfiguration.tsx`) auto-discovers any new whitelisted key — no UI change needed.

# 05 · Localization Packs

## Purpose
Localization packs are how this country-agnostic platform learns to do payroll in any country. A pack is a versioned bundle of tax rules, statutory identifiers, GL account templates, certificate templates, and return templates. Without an installed pack, the payroll engine refuses to compute (readiness fails).

## Data model

| Table | Purpose |
|---|---|
| `localization_packs` | Master registry. `country_code`, `name`, `version`, `is_active`, `is_published`, `tokens_inherit_platform` |
| `pack_versions` | Immutable snapshots. `status ∈ {draft, staged, published, archived}`, `snapshot jsonb`, `changelog jsonb`, `parent_version_id`, `published_by` |
| `pack_requirements` | Required statutory identifiers per pack |
| `pack_rule_type_schemas` | JSON Schema registry per `(rule_type, computation_kind, schema_version)` — used to validate `parameters` payloads on every write |
| `pack_token_registry` | Authoritative list of `{{token}}` paths usable in templates (platform-wide rows have `pack_id IS NULL`) |
| `pack_audit_log` | Append-only mutation history written by trigger |
| `pack_upgrade_proposals` | Per-tenant pending diffs after a new version is published |
| `installed_localization_packs` | What pack version each business is running |
| `localization_pack_account_templates` | Chart-of-accounts seed rows |
| `localization_pack_certificate_templates` | Year-end employee certificate templates |
| `localization_pack_payroll_templates` | Statutory rule seed rows |
| `localization_pack_remittance_schedules` | Filing frequency / authority per rule |
| `localization_pack_return_templates` | Statutory return layout |
| `localization_pack_tax_templates` | Tax rate seeds |
| `pack_account_roles` | GL role mappings for employer-side rules |

## Pack lifecycle

```text
DRAFT pack ─edit rules/templates─► LINT (advisory) ─► PUBLISH version ─► PROMOTE to tenants
                                                              │                       │
                                                              ▼                       ▼
                                                      pack_upgrade_proposals    installed_localization_packs.pack_version bumped
```

### 1. Draft & edit
- Entry: `src/pages/admin/AdminLocalizationPacks.tsx` → `CreatePackDialog` → INSERT `localization_packs`.
- Edit surface: `PackEditorShell.tsx` + `PackEntityTabs.tsx` + `RuleForm.tsx` + `TemplateEditor.tsx`.
- Every write triggers `trg_pack_audit_log_writer` → row in `pack_audit_log`.
- **Per-row validation** at DB level: `trg_assert_pack_payload_valid` calls `assert_pack_payload_valid()` which validates the row's `parameters` payload against the JSON Schema in `pack_rule_type_schemas` for the given `(rule_type, computation_kind)`.
- Token picker uses `useTokenRegistry(pack_id)` which UNIONs platform-wide tokens with pack-specific tokens.

### 2. Lint (cross-row sanity)
Edge fn `lint-localization-pack`. Checks:
1. Every employer-side rule must have a `pack_account_roles` entry → **error**.
2. Rules with `remittance_frequency` need a `localization_pack_remittance_schedules` row → **error**.
3. Annual rules should have a certificate template → **warning**.
4. `superseded_by` must point to a rule in the same pack → **error**.
5. Every `{{token}}` in any template body must exist in `pack_token_registry` → **error**.
6. Orphan `pack_account_roles` → warning.
7. Orphan remittance schedule → warning.

**Risk**: the publish edge function does not call lint (ADR-0036 §I6 is not enforced in code). The `PublishToggle` on the admin page also bypasses lint. See Chapter 13.

### 3. Publish (snapshot)
Edge fn `publish-localization-pack-version`:
1. Auth: JWT + `is_platform_admin(user.id)` → 403 otherwise.
2. Snapshot all 6 `PACK_TABLES` + the `localization_packs` row in parallel SELECTs → `snapshot jsonb`.
3. Naive deep-diff vs previous published version → `changelog.tables[t][{id, kind, fields}]`.
4. INSERT `pack_versions` (`status='published'`, `parent_version_id`, `published_by`).
5. If `propose_upgrades=true` (default): scan `installed_localization_packs`; for tenants not on the new version, INSERT `pack_upgrade_proposals(status='pending')`.

**Risk**: `PackDiffView` in the tenant inbox reads `p.diff?.before / p.diff?.after` but the changelog format does not contain those keys, so the diff view is currently empty. See Chapter 13.

### 4. Promote
Edge fn `promote-pack-version`:
- `scope='all_tenants'` (platform-admin) — bumps every `installed_localization_packs.pack_version` to target.
- `scope='self'` — only the caller's orgs.
- INSERT `pack_upgrade_proposals(status='accepted')` for audit.

**Important**: promotion does **not** re-seed `payroll_statutory_rules` / `tax_rates` / `accounts` for the new version. Tenants whose runtime rules were seeded from an older snapshot keep the old runtime rows. If you need refreshed runtime rows, re-install with `force_reseed=true`.

### 5. Install (per tenant)
Edge fn `install-localization-pack` → RPC `install_localization_pack_atomic(business_id, pack_id, installed_by, force_reseed)`:
1. Membership check (`AUTH_NO_ROLE_FOR_ORG` → 403).
2. Resolve `pack_id` from `country_code` if not provided (must be active + published).
3. Atomic seed (SECURITY DEFINER):
   - **tax_rates** ← `localization_pack_tax_templates` (skip dup on `(org, business, name)`).
   - **accounts** ← `localization_pack_account_templates` (skip dup on `(org, business, code)`), second pass sets `parent_id` via `parent_code` join.
   - **payroll_statutory_rules** ← `localization_pack_payroll_templates` (`rule_code` from `parameters->>'code'` or slugified `rule_name`; skip on `(org, country_code, rule_type, rule_name)`).
4. INSERT/UPDATE `installed_localization_packs`.
5. `payroll_finalize_pack_install_v2(org, business)` — applies GL mapping suggestions via `payroll_apply_proposed_mappings` / `payroll_create_and_map_account` (ADR-0022). Returns `applied_mappings`, `created_accounts`, `failures` — non-fatal.
6. Token registry check: if `tokens_inherit_platform=false` and `pack_token_registry` is empty for the pack → write `payroll_diagnostics(code='PACK_TOKEN_REGISTRY_EMPTY')`.

Errors are classified by SQLSTATE → code mapping (`23502→INSTALL_SCHEMA_DRIFT`, `23505→INSTALL_DUPLICATE (409)`, `P0002→NOT_FOUND`, `P0001→PAYROLL_NOT_INSTALLED | APP_NOT_INSTALLED | ENTITLEMENT_REQUIRED | INSTALL_PRECONDITION_FAILED`).

### 6. Runtime consumption

- **Payroll compute** reads `payroll_statutory_rules WHERE organization_id=? AND country_code=?`. Engine dispatches on `computation_method` only (ESLint rule `no-literal-rule-codes-in-engines`).
- **Token rendering** is centralized in `supabase/functions/_shared/renderTokens.ts`. Unresolved tokens become `‹unresolved: token›` and write a `payroll_diagnostics(code='TOKEN_UNRESOLVED')` row.
- **Certificates & returns** read pack templates and merge tenant overrides (`payroll_certificate_template_overrides`, `payroll_return_template_overrides`).
- **Identifiers** required for a country are read from `pack_requirements`. UI validation must not branch on country code (ADR-0036 §I4).

### 7. Upgrade proposals
- Edge fn `propose-localization-upgrades` (manual re-trigger) idempotently fans out new published versions into `pack_upgrade_proposals` for each installed tenant.
- Tenant view: `src/pages/hr/payroll/Localization.tsx`. Decision via `useDecidePackUpgradeProposal()` — direct UPDATE of `status`, `decided_by`, `decided_at`, `decision_notes`.
- RLS: SELECT/UPDATE scoped by `is_org_member`; INSERTs only via service-role edge functions.

## Invariants (ADR-0036)

| # | Invariant | Enforcement |
|---|---|---|
| I1 | No literal `rule_code` in engines | ESLint `no-literal-rule-codes-in-engines.js` + arch test |
| I2 | No literal ISO country codes in payroll UI/compute | ESLint + `no-country-switch-in-payroll-ui.test.ts` |
| I3 | Statutory identifiers in dedicated tables only | `*_statutory_identifiers` |
| I4 | `pack_requirements` drives identifier validation | Required-field UI must not branch on country |
| I5 | Single token resolver | `_shared/renderTokens.ts` |
| I6 | Lint gate before publish | **UNVERIFIED — not in publish edge fn** |
| I7 | Atomic install/uninstall | `install_localization_pack_atomic` + `uninstall_localization_pack` |
| I8 | GL mapping via RPC only | `payroll_apply_proposed_mappings` / `payroll_create_and_map_account` |
| I9 | Payslip surface contract | `payslip_header` RPC + `payslip_lines` table |
| I10 | Synthetic-pack integration test | Exercises every `computation_method` |

> Full evidence: `./_research/04-localization-packs.md`.

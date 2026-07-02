# Research: Localization Packs

Source: sub-agent investigation `sub_cmtc4w5p`. Verified read-only against current codebase. Input for chapter `05-localization-packs.md`.

## 0. Data Model

| Table | Purpose | Key Columns |
|---|---|---|
| `localization_packs` | Master registry | `id`, `country_code`, `name`, `version`, `is_active`, `is_published`, `tokens_inherit_platform` |
| `pack_versions` | Immutable snapshots | `pack_id`, `version`, `status ∈ {draft,staged,published,archived}`, `snapshot jsonb`, `changelog jsonb`, `parent_version_id`, `published_by` |
| `pack_requirements` | Identifier requirements | `pack_id`, `identifier_key`, `required` |
| `pack_rule_type_schemas` | JSON Schema registry per `(rule_type, computation_kind, schema_version)` | `json_schema`, `ui_schema`, `token_outputs` |
| `pack_token_registry` | Token source of truth (`pack_id IS NULL` = platform-wide) | `token_path`, `source`, `data_type`, `deprecated_in_version` |
| `pack_audit_log` | Append-only mutation history | `pack_id`, `organization_id`, `actor_id`, `scope`, `entity_table`, `entity_id`, `action`, `before`, `after` |
| `pack_upgrade_proposals` | Per-tenant pending diffs | `organization_id`, `business_id`, `pack_id`, `from_version`, `to_version`, `diff jsonb`, `status` |
| `installed_localization_packs` | Per-business install registry | `organization_id`, `business_id`, `pack_id`, `pack_version`, `installed_by`, `status` |
| `localization_pack_account_templates` | COA seed | `code`, `account_type`, `parent_code`, `is_system` |
| `localization_pack_certificate_templates` | Year-end cert templates | `rule_code`, `body jsonb` |
| `localization_pack_payroll_templates` | Statutory rule seed | `rule_type`, `rule_name`, `computation_method`, `parameters jsonb` |
| `localization_pack_remittance_schedules` | Filing frequency per rule | `rule_code`, `frequency` |
| `localization_pack_return_templates` | Statutory return layout | `rule_code`, `body jsonb` |
| `localization_pack_tax_templates` | Tax rate seed | `name`, `rate`, `is_compound`, `is_inclusive` |
| `pack_account_roles` | GL role mappings for employer-side rules | `rule_code`, `role_key` |

## 1. Publisher — Draft Pack Creation
Entry: `src/pages/admin/AdminLocalizationPacks.tsx`. `usePacks({scope:"admin"})` (`src/features/localization/hooks/usePack.ts:82`). `CreatePackDialog` (line 218) → `adminFrom("localization_packs").insert({is_published:false, is_active:true})`. `PublishToggle` (line 200) toggles `is_published` directly via service-role client.

**Risk**: `PublishToggle` is a direct DB write that **does not call `lint-localization-pack`** despite ADR 0036 §I6 mandate. The intent is likely that the toggle only controls discoverability; no DB-level guard prevents a malformed pack from being toggled to `is_published=true`.

## 2. Pack Editing
Entries: `PackEditorShell.tsx` (tabs: Edit / Versions / Health / Audit), `PackEntityTabs.tsx`, `RuleForm.tsx`, `TemplateEditor.tsx`.

Validation:
- **Client preview**: `validate-localization-payload` edge fn via `validatePayload()` (`src/features/localization/hooks.ts:53`).
- **DB-level**: `trg_assert_pack_payload_valid` fires `BEFORE INSERT OR UPDATE` on `payroll_statutory_rules` and `localization_pack_payroll_templates`. Rejects if `parameters` payload fails JSON Schema from `pack_rule_type_schemas` for the `(rule_type, computation_kind)` pair.
- **Legacy rows**: flagged `legacy_unvalidated=true`; surfaced in `PackHealthPanel` via `usePackHealth`.

Token picker queries `useTokenRegistry(pack_id)` (`pack_id IS NULL OR pack_id = ?`).
Every write fires `trg_pack_audit_log_writer` → INSERT into `pack_audit_log`.

## 3. Lint (Pre-publish)
`supabase/functions/lint-localization-pack/index.ts`. Cross-row invariants:
1. Employer-side rules must have a `pack_account_roles` entry → error.
2. Rules with `remittance_frequency` must have a `localization_pack_remittance_schedules` row → error.
3. Annual rules should have a `localization_pack_certificate_templates` row → warning.
4. `superseded_by` must point to a rule within the same pack → error.
5. Every `{{token}}` in any template body must exist in `pack_token_registry` (via `extractTokens` in `_shared/validateAgainstSchema.ts`) → error.
6. Orphan `pack_account_roles` (rule doesn't exist) → warning.
7. Orphan remittance schedule → warning.

No auth check — uses `SERVICE_KEY`; caller authentication expected upstream.

## 4. Publish Version
`supabase/functions/publish-localization-pack-version/index.ts`. Hook `usePublishPackVersion()`. UI trigger `handlePublish()` in `PackEditorShell.tsx:84`.

1. Auth: JWT + `is_platform_admin(user.id)` → 403 if not admin.
2. Resolve prev published version (`pack_versions WHERE status='published'` latest).
3. `snapshotPack()` — parallel SELECTs of all 6 `PACK_TABLES` + `localization_packs` → `snapshot jsonb`.
4. Compute `changelog` — naive deep diff (JSON-pointer paths) per table per row: `added`, `modified` (`fields: {path:{from,to}}`), `removed`.
5. INSERT `pack_versions` with `status='published'`, `published_at`, `published_by`, `parent_version_id`.
6. If `propose_upgrades=true` (default): scan `installed_localization_packs WHERE pack_id=?`, skip already-on-target, INSERT `pack_upgrade_proposals(status='pending')` per tenant.

**Risk (UNVERIFIED)**: ADR 0036 §I6 mandates lint must pass before snapshot. Lint call is **not present** in current `publish-localization-pack-version/index.ts` source.

Cache invalidation on success: `["pack-versions"]`, `["localization-pack"]`, `["pack-upgrade-proposals"]`, `["pack-audit-log"]`.

## 5. Promote Pack Version
`supabase/functions/promote-pack-version/index.ts`. Hook `usePromotePackVersion()`. UI trigger Versions tab `PackEditorShell.tsx:248`.

1. Validate target `pack_versions` row (must be `published`).
2. `scope='all_tenants'` requires `is_platform_admin` → fetches all `installed_localization_packs WHERE pack_id=?`.
3. `scope='self'` resolves caller's orgs via `user_roles WHERE user_id=? AND is_active=true`.
4. For each install (skipping already-on-target): UPDATE `installed_localization_packs.pack_version=tgt.version`.
5. INSERT `pack_upgrade_proposals(status='accepted')` for audit trail.

**Risk**: Promotion does NOT re-seed `payroll_statutory_rules` / `tax_rates` / `accounts` for the promoted version. It only bumps the version string. Tenants whose runtime tables were seeded from an older pack snapshot are not automatically updated.

## 6. Org Install
Entries: `LocalizationPackSettings.tsx` (tenant), `OnboardingSetup.tsx` (auto-install during onboarding). Edge fn `install-localization-pack`. RPC `install_localization_pack_atomic(_business_id, _pack_id, _installed_by, _force_reseed)`.

1. JWT validated; `user_roles` membership check → `AUTH_NO_ROLE_FOR_ORG` (403).
2. `pack_id` resolved from `country_code` fallback (`is_active AND is_published`).
3. Atomic RPC (SECURITY DEFINER):
   - `installed_localization_packs` check → early-return `already_installed=true` unless `force_reseed`.
   - **seed_tax_rates**: INSERT `tax_rates` from `localization_pack_tax_templates` (skip dup by `(org,business,name)`).
   - **seed_accounts**: INSERT `accounts` from `localization_pack_account_templates` (skip dup by `(org,business,code)`); second pass sets `parent_id` via `parent_code` join.
   - **seed_payroll**: INSERT `payroll_statutory_rules` from `localization_pack_payroll_templates`; `rule_code` from `parameters->>'code'` or slugified `rule_name`; skip by `(org,country_code,rule_type,rule_name)`.
   - INSERT or UPDATE `installed_localization_packs`.
4. Post-install: `payroll_finalize_pack_install_v2(_org_id,_business_id)` applies GL mapping suggestions (`payroll_apply_proposed_mappings` / `payroll_create_and_map_account`). Returns `applied_mappings`, `created_accounts`, `failures`.
5. Token check: if `tokens_inherit_platform=false` and `pack_token_registry` is empty for the pack → INSERT `payroll_diagnostics(code='PACK_TOKEN_REGISTRY_EMPTY', severity='warning')`.

Tables mutated: `tax_rates`, `accounts`, `payroll_statutory_rules`, `installed_localization_packs`, `default_account_settings` (via finalize RPC), `payroll_diagnostics`.

Error classification (`classifyInstallError`): SQLSTATE → code:
`23502→INSTALL_SCHEMA_DRIFT`, `22P02→INSTALL_INVALID_DATA`, `23505→INSTALL_DUPLICATE (409)`, `P0002→NOT_FOUND`, `23514→INSTALL_CHECK_VIOLATION`, `P0001→PAYROLL_NOT_INSTALLED | APP_NOT_INSTALLED | ENTITLEMENT_REQUIRED | INSTALL_PRECONDITION_FAILED`.

**Risks**:
- `payroll_rule_types` is NOT written by install RPC. Hydration mechanism UNVERIFIED.
- `force_reseed=true` re-runs account seeding but skips duplicates by code — partial reseed of divergent COA, not full reset.
- GL auto-mapping failures are non-fatal; surface in response body; pack install commits regardless.

## 7. Runtime Consumption
### 7a. Payroll compute
`compute-payroll` reads `payroll_statutory_rules WHERE organization_id=? AND country_code=?`. Dispatches on `computation_method` (`progressive`, `tiered`, `percentage`, `graduated`, `fixed`) — never on `rule_code` (ESLint rule `no-literal-rule-codes-in-engines`; opt-out via `// LOCALIZATION-EXEMPT`). Writes `payslip_lines` with `category` (`EARNING_CATS / DEDUCTION_CATS / EMPLOYER_CATS`).

### 7b. Token resolution
`supabase/functions/_shared/renderTokens.ts`. `renderTokens(body, ctx)` walks template JSON recursively, substitutes `{{token.path}}`. Misses → `‹unresolved: token›` sentinel + `misses[]`. `renderAndDiagnose(body, ctx, opts)` inserts `payroll_diagnostics(code='TOKEN_UNRESOLVED')` per miss via service role. Consumed by `generate-tax-certificate`, `generate-statutory-return`, `generate-localization-statutory-document`.

### 7c. Certificate / Return generation
Reads `localization_pack_certificate_templates` / `localization_pack_return_templates` by `rule_code` and `pack_id`.
**Known limitation** (`LOCALIZATION_PACKS.md:111`): `body` blocks are **decorative** — `generate-tax-certificate/index.ts:260` uses hard-coded PDF columns, consuming only `template.code`, `display_name`, `layout`. Block-based body renderer not yet wired.

### 7d. Identifier validation
`pack_requirements` is authoritative for required identifiers (ADR 0036 §I4). Employee identifiers in `employee_statutory_identifiers`; employer in `organization_statutory_identifiers`. Payroll reads, never owns input UI.

## 8. Upgrade Proposals
`supabase/functions/propose-localization-upgrades/index.ts`. Tenant UI `src/pages/hr/payroll/Localization.tsx`. Hook `usePackUpgradeProposals({status:'pending'})` (RLS: `is_org_member`).

Fan-out (manual): resolve latest published `pack_versions`, iterate `installed_localization_packs`, idempotency check on existing pending proposal, INSERT `pack_upgrade_proposals` with `diff = latest.changelog`.

Tenant decision: `useDecidePackUpgradeProposal()` → direct UPDATE `status`, `decided_by`, `decided_at`, `decision_notes`. RLS: `is_org_member` for UPDATE.

**Risk (rendering)**: `PackDiffView` reads `p.diff?.before / p.diff?.after`, but `publish-localization-pack-version` stores diff at `changelog.tables[t][{id,kind,fields}]` (no top-level `before`/`after`). Confirmed rendering gap — `PackDiffView` always receives empty objects.

## 9. Invariants & Guards (ADR 0036)

| # | Invariant | Enforcement |
|---|---|---|
| I1 | No literal `rule_code` in engines | ESLint `no-literal-rule-codes-in-engines.js` + arch test |
| I2 | No literal ISO country codes in payroll UI/compute | ESLint + `no-country-switch-in-payroll-ui.test.ts` |
| I3 | Statutory identifiers in dedicated tables | `organization_statutory_identifiers`, `employee_statutory_identifiers` |
| I4 | `pack_requirements` drives identifier validation | Required-field logic not branched on country |
| I5 | Single token resolver | `_shared/renderTokens.ts` only |
| I6 | Lint gate before publish | **UNVERIFIED** — not in publish edge fn |
| I7 | Atomic install/uninstall | `install_localization_pack_atomic` + `uninstall_localization_pack` |
| I8 | GL mapping via RPC | `payroll_apply_proposed_mappings` / `payroll_create_and_map_account` |
| I9 | Payslip surface contract | `payslip_header` RPC + `payslip_lines` table |
| I10 | Synthetic-pack integration test | All `computation_method` values exercised |

## 10. Consolidated UNVERIFIED / Gaps
1. `publish-localization-pack-version` missing lint gate (ADR 0036 §I6).
2. `PublishToggle` bypasses lint.
3. `PackDiffView` receives empty diff due to schema mismatch.
4. Certificate/return body blocks decorative only.
5. `payroll_rule_types` hydration path untraced.
6. `pack_requirements` not enforced inside install RPC.
7. Tenant override row table (per ADR 0010) not found; per-tenant rule customizations write directly to `payroll_statutory_rules` scoped by `organization_id`, so promotion (which only bumps `installed_localization_packs.pack_version`) does not refresh tenant runtime rows.

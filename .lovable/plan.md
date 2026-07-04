
# Architectural Investigation — Statutory GL Accounts & Localization Pack Ownership

Read this as a written investigation, not a change list. No code moves until the architecture below is agreed. All findings are from tracing the current implementation end-to-end (migrations, edge functions, engine, readiness resolver).

## 1. What the ERP claims to be

Per ADR 0010, ADR 0036 and `docs/audit/2026-05-08-payroll-gl-readiness.md`:

- Country legislation lives **only** inside a localization pack.
- Engines dispatch off `computation_method` + validated `parameters`, never rule codes (`no-literal-rule-codes-in-engines.js`, `no_country_named_functions_test.sql`).
- Chart-of-accounts extensions, statutory rules, remittance schedules, and return templates are all pack rows.
- Install is atomic (`install_localization_pack_atomic`); uninstall is atomic; no other code path may seed `payroll_statutory_rules` or `localization_pack_*`.

So the *stated* lifecycle is:

```text
Organization created
  → Pack selected + install_localization_pack_atomic
      → CoA rows seeded from localization_pack_account_templates
      → payroll_statutory_rules seeded from pack snapshot
      → remittance + return templates seeded from pack
      → default_account_settings auto-mapped via payroll_gl_readiness
  → payroll_setup_status flips to ready
  → Payroll runs; posts through payroll_apply_proposed_mappings only
```

That is the correct enterprise pattern and mirrors Odoo (`l10n_ke` module), SAP (Country Version + localized CoA), Oracle (Legislative Data Group), and D365 (country regional feature packages): the core has no knowledge of PAYE / NITA / SHIF; each is a row inside an installable country package.

## 2. What the code actually does — architectural leakage found

The pack layer is correct. The leakage is in three separate places that write country-specific artifacts *outside* the pack pipeline.

### Leak A — Core registry contains country-specific role keys

`system_account_roles` is a **platform-wide** table (no `pack_id` column). It is meant to enumerate country-agnostic role slots (`salary_expense`, `net_salary_payable`, `payroll_clearing`, etc.).

Country-specific role keys are being inserted into it directly by non-pack migrations:

- `20260620164645` — inserts `nita_payable`.
- `20260529203853` / `20260604172133` — insert `employer_nita_expense`. The 20260604 migration's own comment states the reason:
  > *"Re-registered globally because the pack installer does not seed system_account_roles; the prior cleanup that removed this role broke statutory rule validation."*

That comment is the smoking gun: the core registry is being used as a dumping ground because the pack lifecycle does not own role registration. This is exactly the leakage the ADRs forbid.

### Leak B — Direct writes to tenants' `accounts` table, outside the pack

`20260525204357` (payroll hardening Phase 2) runs a `DO $$ … FOR r IN businesses LOOP …` block that INSERTs Kenya-specific CoA rows (`'2170' Affordable Housing Levy Payable`, `'2175' NITA Payable`, `'6014' Employer NITA Contribution`, …) into every tenant's `public.accounts`, tagged `is_system=true`, "Auto-provisioned by payroll hardening Phase 2".

The Kenya pack already declares these accounts in `localization_pack_account_templates` (`20260223091411`, codes `2034` / `6014`). So we now have:

- Two competing codes for the same statutory obligation (`2034` from the pack, `2175` from the hardening migration) living side-by-side.
- Provisioning that runs *unconditionally for every business*, regardless of which pack (if any) is installed. A South-African-only tenant still gets a `NITA Payable` account.

This is the most visible symptom of the leak — it is the reason the user sees NITA accounts in a system that markets itself as country-agnostic.

### Leak C — Engine/readiness knowledge of statutory identifiers

The readiness resolver (`payroll_gl_readiness`) derives keys from `payroll_statutory_rules` (correct). But the AI route catalog and `payslipDrillDown.ts` still carry a regex listing `paye|nhif|shif|nssf|ahl|nita|kenya|…`. That is not a runtime leak (it's UX heuristics) but it *is* a signal that country vocabulary keeps re-entering core surfaces because the pack layer has no formal contract for surfacing "human labels for statutory artifacts".

## 3. Ownership matrix — where each artifact should live

| Artifact | Correct owner | Current owner | Verdict |
|---|---|---|---|
| Country CoA extension (NITA Payable, PAYE Payable, …) | Pack (`localization_pack_account_templates`) | Pack **and** core hardening migration (`accounts` direct insert) | Leaked |
| Role-key registry entry (`nita_payable`) | Pack (`pack_account_roles`, joined to a *pack-scoped* registry) | Pack **and** `system_account_roles` (global) | Leaked |
| `role_key → account_type / detail_type` policy | Pack | Core (`payroll_account_role_policy` with hard-coded `%_employer_expense`, `%_payable` patterns) | Acceptable — patterns are country-agnostic |
| Statutory rule row | Pack (`payroll_statutory_rules` seeded via `install_localization_pack_atomic`) | Pack | Correct |
| Remittance / return templates | Pack | Pack | Correct |
| Auto-mapping into `default_account_settings` | `payroll_apply_proposed_mappings` | Same | Correct |
| GL posting engine | Core, dispatches on `computation_method` | Core, correct | Correct |

The rot is confined to CoA seeding and role-key registration.

## 4. Correct event-driven lifecycle

```text
[EVENT] OrganizationCreated
      └── seeds only country-agnostic core CoA + core role registry
[EVENT] LocalizationPackSelected(pack_id, version)
[EVENT] LocalizationPackInstallStarted
      ├── register pack-scoped role keys      (pack_account_roles → registry view)
      ├── extend CoA from pack templates      (localization_pack_account_templates → accounts)
      ├── seed statutory rules                (payroll_statutory_rules)
      ├── seed remittance schedules           (localization_pack_remittance_schedules)
      ├── seed return templates               (localization_pack_return_templates)
      ├── seed tax templates                  (localization_pack_tax_templates)
      └── auto-map default_account_settings   (payroll_apply_proposed_mappings)
[EVENT] LocalizationPackInstallCompleted
      └── refresh payroll_setup_status; publish PackInstalled event
[EVENT] LocalizationPackUninstallStarted
      ├── unmap default_account_settings owned by this pack
      ├── deactivate statutory rules bound to this pack
      ├── retire pack-provisioned CoA rows (soft-delete if referenced)
      └── deregister pack-owned role keys
[EVENT] LocalizationPackUninstallCompleted
```

Two invariants derive from this:

- **I-OWN-1** Every country-specific row (CoA account, role key, statutory rule, remittance, return, token) must carry a `pack_id` FK, and must be created / retired *only* through the install / uninstall / upgrade RPCs.
- **I-OWN-2** The core registry (`system_account_roles`) may contain **only** role keys that are meaningful in every country. Country-specific role keys live in a pack-scoped table (or a view that unions core + `pack_account_roles`).

## 5. Benchmarks (principles, not copies)

- **Odoo** — `l10n_ke`, `l10n_ug`, … each package ships CoA templates and tax templates. Core `account` module knows nothing about NITA.
- **SAP** — Country Version + Chart of Accounts variant; statutory GL accounts live in the country CoA, mapped to global operating CoA via account-determination tables.
- **Oracle HCM / Fusion** — Legislative Data Group (LDG) owns statutory balances and account combinations; core Payroll dispatches by LDG.
- **Dynamics 365 F&O** — Country/region feature packs; the "Localization framework" registers artifacts through a manifest and never mutates the core CoA directly.

Shared principle: **a country package is a first-class installable unit whose lifecycle events are the only path by which country artifacts enter the tenant.** Our ADRs already state this; the migrations under investigation violate it.

## 6. Recommendations (order matters — do not skip)

The plan below is a *sequence of investigations and structural changes*, each independently reviewable. No implementation happens until section 6.1 is signed off.

### 6.1 Freeze new leaks (documentation-only)

- Add an ADR "0047 — Pack-owned statutory accounts and role registry" that ratifies I-OWN-1 / I-OWN-2 and supersedes the ad-hoc backfills.
- Extend `no_country_named_functions_test.sql` with a companion test that rejects future migrations inserting country-flavoured `role_key` values into `system_account_roles` (deny-list on `%nita%|%paye%|%shif%|%ahl%|%nssf%|%nhif%|%kra%|…`).
- Extend the eslint / SQL scan surface used by the audit to fail if a migration writes to `public.accounts` inside a `FOR business LOOP` without going through the install RPC.

### 6.2 Reclassify existing leaks as pack-owned

- Introduce `pack_id` (nullable for legacy rows) on `system_account_roles` **or** move country role keys out to `pack_account_roles` and expose a `v_account_roles` union view for consumers. Preferred: the latter — keeps the core registry pure.
- Rewrite `install_localization_pack_atomic` to register `pack_account_roles` rows into whichever store the resolver reads.
- Migrate the two existing role keys (`nita_payable`, `employer_nita_expense`) from `system_account_roles` into the Kenya pack; drop them from the core registry after the migration.

### 6.3 Remove the direct-write CoA seeding

- Delete the auto-provisioning loops in `20260525204357` (and any successor) as a *forward* migration: remove rows that (a) were created with `description='Auto-provisioned by payroll hardening Phase 2'`, (b) have no journal activity, and (c) are duplicated by a pack template. Rows with activity are re-parented to the pack's canonical account via `default_account_settings` remapping — never silently deleted.
- Rely exclusively on `install_localization_pack_atomic` + `payroll_gl_readiness` + `payroll_apply_proposed_mappings` for future provisioning.

### 6.4 Backfill missing pack coverage

- Any statutory obligation currently only reachable via the hardening migration (verify by diffing the two account sets per pack) gets a pack template row + `pack_account_roles` entry, then the hardening rows are retired per 6.3.

### 6.5 Regression fences

- Architecture tests: fail CI if `accounts` contains a row whose `code` matches a pack template but whose `business_id` is not associated with an `installed_localization_packs` row for that pack.
- Architecture tests: fail CI if `system_account_roles.role_key` matches the country deny-list.
- Extend the audit doc under `docs/audit/` with the closure record.

## 7. Open questions for you before implementation

1. Do we treat the duplicated NITA codes (`2034` from pack vs `2175` from hardening) as *the same account* for migration purposes, or preserve both and only reroute mappings?
2. Should the pack-scoped role registry replace `system_account_roles` entirely for country rows (my recommendation), or should we keep a shadow row in `system_account_roles` for backward compatibility?
3. Are there tenants in production that have already posted journals against the `2175`-family accounts? That determines whether 6.3 can drop rows or must only re-map them.

Answering these three unlocks the concrete migration + code plan in section 6. Until then, the deliverable of this investigation is the diagnosis above and the ownership matrix in §3.

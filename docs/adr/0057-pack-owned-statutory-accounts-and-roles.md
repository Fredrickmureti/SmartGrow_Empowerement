# ADR 0057 — Pack-Owned Statutory Accounts and Role Registry

**Status:** Accepted — 2026-07-04
**Owners:** Platform / HR-Payroll / Accounting
**Supersedes / relates to:** ADR 0010 (localization pack versioning),
ADR 0036 (country-agnostic payroll completion), ADR 0047 (statutory
rules legislative cockpit), and the payroll GL readiness audit
`docs/audit/2026-05-08-payroll-gl-readiness.md`.

## Context

An architectural review triggered by the discovery of `NITA Payable` and
`Employer NITA Contribution` accounts in the core system found three
ways country-specific statutory artifacts were entering tenants outside
the localization-pack lifecycle:

1. **Core role registry pollution.** `system_account_roles` (a
   platform-wide table with no `pack_id` column) was carrying
   country-specific role keys `nita_payable` and `employer_nita_expense`.
   Migration `20260604172133` documents the cause in its own comment:
   *"Re-registered globally because the pack installer does not seed
   system_account_roles; the prior cleanup that removed this role
   broke statutory rule validation."*
2. **Direct CoA writes into every tenant.** Migration `20260525204357`
   loops over every `businesses` row and inserts a fixed set of
   Kenya-specific accounts (`2170 Affordable Housing Levy Payable`,
   `2175 NITA Payable`, `6014 Employer NITA Contribution`, …) with
   `is_system=true`, regardless of which pack the tenant has installed.
   The Kenya pack already declares equivalent accounts through
   `localization_pack_account_templates` (`20260223091411`, codes `2034`
   / `6014`), leaving two competing codes for the same statutory
   obligation.
3. **Country vocabulary in core UX heuristics.** The AI route catalog
   and `payslipDrillDown.ts` still carry a regex hard-coded with
   `paye|nhif|shif|nssf|ahl|nita|kenya|…`. This is not a runtime leak,
   but it is a symptom of the same missing contract.

ADRs 0010 and 0036 already state that country legislation lives only in
localization packs and that engines dispatch off `computation_method` +
validated `parameters`. This ADR closes the last remaining gap: the
*accounting-side* artifacts (CoA rows and role registry entries) must
follow the same lifecycle.

## Decision

Two invariants are locked. Any future change that violates one of them
must ship a new ADR superseding this one or carry an explicit
`// LOCALIZATION-EXEMPT: <reason>` opt-out reviewed by HR-Payroll and
Accounting.

### I-OWN-1 — Every country-specific artifact carries a `pack_id`

Every country-specific row — CoA account, role key, statutory rule,
remittance schedule, return template, tax template, token — must carry a
`pack_id` FK (directly or through a join row) and must be created,
updated, or retired **only** through the install / upgrade / uninstall
RPCs (`install_localization_pack_atomic`,
`apply_pack_upgrade_atomic`, `uninstall_localization_pack`).

Direct writes to `public.accounts` from a migration `DO $$ FOR business
LOOP …` — or from any code path other than the install RPC and the
existing GL-readiness mapping RPCs
(`payroll_apply_proposed_mappings`, `payroll_create_and_map_account`)
— are prohibited.

### I-OWN-2 — The core role registry is country-neutral

`system_account_roles` may contain **only** role keys that are
meaningful in every country: `salary_expense`, `net_salary_payable`,
`payroll_clearing`, and other cross-jurisdiction concepts.
Country-specific role keys live in `pack_account_roles` (already
pack-scoped) and are surfaced to consumers through the union view
`v_account_roles` introduced by this ADR.

Consumers of role metadata (readiness resolver, editor UI, validation
trigger) query `v_account_roles`, not `system_account_roles` directly.

## Consequences

**Positive**

- Adding a new country's statutory accounts requires *only* pack
  authoring: template rows + `pack_account_roles`. No core migration,
  no `system_account_roles` insert.
- Uninstalling a pack cleanly retires its role keys and CoA rows; no
  ghost `nita_payable` role survives after a Kenya pack removal.
- A tenant that never installs the Kenya pack never sees NITA accounts.
- The pack becomes a self-contained, portable unit — aligned with
  Odoo's `l10n_*` modules, SAP's Country Version, Oracle's LDG, and
  D365's country/region feature packs.

**Negative / cost**

- Two existing role keys (`nita_payable`, `employer_nita_expense`)
  must be migrated from `system_account_roles` into the Kenya pack.
- Duplicate NITA CoA rows created by `20260525204357` need a
  data-migration decision (see Migration Plan below).
- Consumers reading `system_account_roles` directly must be repointed
  at the `v_account_roles` view.

## Migration plan (staged)

Executed in the order below, each stage as its own migration:

1. **Regression fences.** Add pgTAP test
   `no_country_role_keys_in_core_registry_test.sql` that fails if
   `system_account_roles.role_key` matches the country deny-list
   (`nita`, `paye`, `shif`, `ahl`, `nssf`, `nhif`, `kra`, `sha`, `payg`,
   `usc`, `sdl`). Extend the country-guard scan to reject `INSERT INTO
   public.accounts` inside a business loop from non-install migrations.
2. **View + resolver contract.** Introduce `v_account_roles` as
   `system_account_roles UNION ALL pack_account_roles (projected)`.
   Repoint the payroll readiness resolver and the statutory-rule
   validation trigger onto the view.
3. **Role reassignment.** Move `nita_payable` and
   `employer_nita_expense` from `system_account_roles` into the Kenya
   pack's `pack_account_roles` (the rows already exist there — this
   step is deleting the core-registry duplicates once the view is live).
4. **CoA de-duplication.** Determined by the answers to the three
   open questions in `.lovable/plan.md` §7. Two paths:
   - If no journal activity exists against the `2175`-family accounts:
     drop them and rewire `default_account_settings` to the pack
     canonical codes (`2034` / `6014`).
   - If activity exists: keep both accounts, mark the hardening rows
     `is_system=false, description='LEGACY — see ADR 0057'`, and
     rewire mappings on a going-forward basis only.
5. **Retire the hardening loop.** Add a forward migration that
   documents `20260525204357`'s hardening loop as historical and
   forbids re-running it. The install RPC becomes the sole source.

## Out of scope

- The AI route-catalog regex and `payslipDrillDown.ts` heuristics
  (Leak C in the investigation): tracked separately; not required for
  runtime correctness.
- Non-payroll localization (accounting taxonomies remain governed by
  ADR 0010's follow-on).

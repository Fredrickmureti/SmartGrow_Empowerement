# ADR 0010 — Localization-Pack Versioning, Schema Validation, and Token Resolution

**Status:** Accepted — 2026-05-15
**Owners:** Platform / HR-Payroll
**Supersedes / relates to:** ADR 0004 (platform vs tenant), ADR 0006 (platform admin), HR architecture doc.

## Context

The platform ships country-specific HR/payroll behaviour through *localization
packs*. Packs hold statutory rules, payroll templates, certificate/return
templates, account mappings, and remittance schedules. Tenants install a pack
and may override individual rows for their own business needs.

Before this ADR the system had three structural problems:

1. **No schema enforcement.** Pack rows accepted arbitrary JSON, so a typo in
   the editor could silently break a payroll run weeks later.
2. **No version history.** A pack edit overwrote the live row in place; there
   was no way to compare versions, roll back, or push fixes to existing
   tenants without manually re-installing.
3. **Engine-side hard-codes.** `compute-payroll`, `generate-tax-certificate`,
   and `generate-statutory-return` carried literal `rule_code === 'PAYE'`
   branches, so adding a country required a code change.

## Decision

We adopt a four-part architecture:

### 1. Authoritative JSON Schemas

`pack_rule_type_schemas` stores one JSON Schema per `(rule_type,
computation_kind, schema_version)`. The DB trigger
`trg_assert_pack_payload_valid` rejects any insert/update on
`payroll_statutory_rules` and `localization_pack_*_templates` whose payload
fails the matching schema. Rows authored before the validator landed are
flagged `legacy_unvalidated=true` and surfaced in the editor's Health tab.

The *same* schemas drive the editor UI through `SchemaForm`, so frontend and
backend cannot drift.

### 2. Immutable Versions + Auto-fan-out

`pack_versions` snapshots a pack at publish time. The
`publish-localization-pack-version` edge function:

- snapshots all pack child rows into `pack_versions.snapshot`,
- diffs against the previous published snapshot,
- writes a `pack_upgrade_proposals` row per installed tenant so each tenant
  can review and accept/reject the upgrade in their own editor.

Tenants see proposals in the new
`/hr/payroll/configuration/localization` route's inbox.

### 3. Token Registry + Single Resolver

`pack_token_registry` is the source of truth for every token a template body
can reference. The shared resolver
`supabase/functions/_shared/renderTokens.ts` is the **only** place tokens get
substituted at runtime. Misses:

- render as the `‹unresolved: token›` sentinel (matches the editor preview),
- write a `payroll_diagnostics` row with `code='TOKEN_UNRESOLVED'` so admins
  can spot drift after an upgrade.

### 4. Engine Guard

`eslint-rules/no-literal-rule-codes-in-engines.js` forbids equality checks
and switch cases against PAYE/NSSF/SHIF/AHL/NHIF/VAT etc. inside the engine
functions. Engines must dispatch off `computation_method` and validated
`parameters`. Opt-out requires a `// LOCALIZATION-EXEMPT: <reason>` marker.

## Consequences

**Positive**

- A malformed rule cannot reach the database.
- Tenant overrides survive upstream upgrades — they're surfaced as a diff,
  not silently overwritten.
- Adding a new country no longer touches engine code; the schemas + tokens
  + a fresh pack are sufficient.
- Editor and engines share the same validators and the same token sentinel,
  so the preview matches the runtime.

**Negative / cost**

- Schema authoring is upfront work for every new `(rule_type,
  computation_kind)` combination.
- Tenants now have to act on upgrade proposals; this is an inbox they didn't
  have before.
- Engines lose some of the convenience of inline branching; new behaviour
  goes through a `computation_method` instead.

## Out of scope

- Public marketplace for community packs.
- Multi-language UI strings (handled separately by i18n).
- Non-payroll localization (accounting taxonomies are still pack rows but
  not yet schema-validated; that's a follow-on ADR).

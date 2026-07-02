# Localization Packs — Architecture

> Companion document to ADR 0010. Read that first for the *why*; this file
> is the *how*.

## Layers

```text
            ┌────────────────────────────────────────────┐
            │  Editors (admin + tenant)                  │
            │   src/features/localization/               │
            │   src/pages/admin/AdminLocalizationPacks   │
            │   src/pages/hr/payroll/Localization        │
            └──────────────────┬─────────────────────────┘
                               │ react-query hooks
                               ▼
            ┌────────────────────────────────────────────┐
            │  Validation surface                        │
            │   edge fn: validate-localization-payload   │
            │   trigger: trg_assert_pack_payload_valid   │
            └──────────────────┬─────────────────────────┘
                               ▼
            ┌────────────────────────────────────────────┐
            │  Storage                                   │
            │   localization_packs                       │
            │   localization_pack_*_templates            │
            │   payroll_statutory_rules (tenant override)│
            │   pack_versions / pack_upgrade_proposals   │
            │   pack_audit_log / pack_token_registry     │
            │   pack_rule_type_schemas                   │
            └──────────────────┬─────────────────────────┘
                               ▼
            ┌────────────────────────────────────────────┐
            │  Runtime engines                           │
            │   compute-payroll                          │
            │   generate-tax-certificate                 │
            │   generate-statutory-return                │
            │   _shared/renderTokens.ts                  │
            └────────────────────────────────────────────┘
```

## The shared editor

`src/features/localization/` is consumed by **both** admin and tenant pages.

Component | Purpose
--- | ---
`PackEditorShell` | Pack picker + version timeline + tab host (Edit / Versions / Health / Audit). `mode='admin' \| 'tenant'` toggles publish/audit affordances.
`PackEntityTabs` | Per-pack child editors: rules → `RuleForm`, templates → `TemplateEditor`, structured master data → `ReferenceList`.
`RuleForm` | Schema-driven editor for a single rule; live-validates against `validate-localization-payload`.
`TemplateEditor` | Block editor (header/body/totals/signature/custom) with `TokenPicker`, server validation, and embedded preview.
`PackDiffView` | Field-level diff between two `pack_versions.snapshot` payloads; reused for the tenant upgrade inbox.
`PreviewPanel` | Synthetic-context renderer; mirrors the runtime sentinel.
`PackHealthPanel` | Lists `legacy_unvalidated=true` rows with one-click revalidate.

All hooks live under `hooks/usePack.ts` and honour RLS — tenant users see
their org's installed packs only; admin mutations are gated server-side.

## Versioning lifecycle

1. Admin edits pack rows → trigger validates each write.
2. Admin clicks **Publish version** → `publish-localization-pack-version`:
   - copies all pack child rows into `pack_versions.snapshot`,
   - computes diff vs previous published snapshot,
   - inserts a `pack_upgrade_proposals` row for every installed tenant.
3. Tenant opens `/hr/payroll/configuration/localization` → upgrade inbox.
4. Tenant accepts / rejects per row; decision recorded with actor and notes.
5. Every write hits `pack_audit_log` via `trg_pack_audit_log_writer`.

## Tokens

`pack_token_registry` is the source of truth. Every template body uses
`{{namespace.path}}` references resolved by
`supabase/functions/_shared/renderTokens.ts`:

```ts
import { renderTokens, renderAndDiagnose } from "../_shared/renderTokens.ts";

const { rendered, misses } = renderTokens(template.body, ctx);
// or, with auto-diagnostic logging:
const { rendered } = await renderAndDiagnose(template.body, ctx, {
  organization_id, pack_id, template_code, surface: "payslip",
});
```

Misses become `‹unresolved: token›` and write a `payroll_diagnostics` row.

## Engine discipline

Engines must NOT branch on literal rule_codes. The ESLint rule
`local/no-literal-rule-codes-in-engines` enforces this for:

- `supabase/functions/compute-payroll/**`
- `supabase/functions/generate-tax-certificate/**`
- `supabase/functions/generate-statutory-return/**`
- `supabase/functions/generate-localization-statutory-document/**`

Opt out *only* with `// LOCALIZATION-EXEMPT: <reason>`.

## Adding a new country

1. Insert a `localization_packs` row.
2. Insert child rows (rules, templates, etc.) — the validator will reject
   anything that doesn't match a registered schema.
3. Add tokens to `pack_token_registry` if the templates need new ones.
4. Publish v1.0.0. Tenants installing the country see a clean pack;
   tenants on an existing country see upgrade proposals.

No engine code change required.

## Known limitation — template body is not yet rendered (round 5)

The block-based body that `TemplateEditor` saves into
`localization_pack_*_templates.body` and the per-business overrides in
`payroll_*_template_overrides.body` is currently **decorative**: the
`generate-tax-certificate` and `generate-statutory-return` edge functions
build their PDF columns from hard-coded layouts (see
`generate-tax-certificate/index.ts:260`) and only consume `template.code`,
`display_name`, and `layout` from the row.

The token registry, synthetic preview, and `renderAndDiagnose` resolver
are already in place. The next round should wire a body-driven renderer
(blocks → PDF sections) so what authors see in the editor preview is what
ships in the generated certificate / return. Until then, treat body
edits as documentation that will go live once the renderer lands.


# Localization Publishing & Tenant Editor — Architectural Audit

## 1. What the codebase actually looks like today

Contrary to the premise of "two parallel editors", most of the stack is already unified. The real problems are narrower — a few surface-level divergences and one storage-model split — not a duplicated engine.

### 1.1 Shared foundation (single source of truth)

Everything under `src/features/localization/` is consumed by BOTH platform-admin and tenant surfaces. It exposes an `EditorMode = "admin" | "tenant"` flag that gates capabilities inside shared components:

| Layer | Module | Used by admin? | Used by tenant? |
|---|---|---|---|
| Editor shell | `components/PackEditorShell.tsx` | ✅ `AdminLocalizationPackDetailPage` | ✅ `pages/hr/payroll/Localization.tsx` |
| Entity tabs (rules, tokens, templates, governance, health) | `components/PackEntityTabs.tsx` | ✅ | ✅ |
| Certificate editor | `CertificateTemplateEditor` + `CertificateV3Editor` + `GridDesigner` + `ThemeInspector` | ✅ | ✅ (indirect via `TemplateEditor`) |
| Return template editor | `ReturnTemplateEditor.tsx` | ✅ | ✅ |
| Preview pipeline | `PreviewPanel`, `CertificatePreviewPane`, `ReturnPreviewPane`, `CertificateHtmlSurface` | ✅ | ✅ |
| Rendering engine | `lib/engine/compile.ts` (+ Deno mirror at `supabase/functions/_shared/certificate-engine/compile.ts`, parity-tested) | ✅ | ✅ |
| Validation | `validate-localization-payload` edge fn + `hooks.validatePayload` | ✅ | ✅ |
| Data hooks | `hooks/usePack.ts`, `usePackTokens`, `useTokenRegistryAdmin`, `usePublisherGrants` | ✅ | ✅ (RLS-scoped) |
| Diff / version compare | `PackDiffView`, `VersionCompareCard` | ✅ | ✅ |

There is **one** editor, **one** renderer, **one** preview engine, **one** validator, **one** state model. The engine even has a browser↔edge byte-parity test (`certificate-engine.mirror-parity.test.ts`). This is much closer to the "Localization Engine → Editor → Renderer → Preview → Validation → Publishing → Overrides" target than the brief implies.

### 1.2 Real divergences (the actual debt)

Four issues are genuine and worth fixing. Nothing else in the audit checklist is a real duplication.

**D1 — Two mount patterns for the certificate editor.**
Admin certificate editing was recently moved to a dedicated full-page route (`AdminLocalizationCertificateEdit.tsx`, direct mount of `CertificateTemplateEditor`) to give the Canvas + Inspector + Metadata full viewport. Tenants still edit certificates inside a `WorkflowSheet` drawer opened from `Templates.tsx` via the wrapper `TemplateEditor`. Same component underneath, but tenants get a cramped drawer for a full-page design surface. Publishers and tenants also arrive at the editor through completely different navigation flows.

**D2 — Tenant has TWO parallel pages for the same concept.**
- `pages/hr/payroll/Localization.tsx` mounts `PackEditorShell mode="tenant"` (the unified path with rules, tokens, versions, upgrade proposals).
- `pages/hr/payroll/Templates.tsx` is a separate, override-only UI for certificate + return templates. It reimplements pack/template listing, "customized vN / out-of-date" state chips, override CRUD, and reset-to-default — none of which is coordinated with the shell's Templates tab.

This is where "duplicated components" perception comes from: two tenant entry points, two navigation models, two mental models for the same underlying rows. Admin has one entry point (`PackEditorShell` + the cert full-page).

**D3 — Storage-model split isn't documented in the shell.**
Admin edits `localization_pack_*` rows directly (immutable-on-publish). Tenant edits go to `payroll_certificate_template_overrides` / `payroll_return_template_overrides` via `useTemplateOverrides`. The shell's tenant mode does not currently expose this override lifecycle inside the Templates tab — that's why `Templates.tsx` exists as a workaround. There is no shared "override resolver" hook that the shell can call to render "pack default / customized vN / out-of-date" pills.

**D4 — Publishing UX asymmetry.**
`AdminLocalizationPackPublishPage` (436 lines) is a dedicated publish workflow. The publish dialog inside `PackEditorShell` is a lightweight WorkflowSheet. They target the same edge function but present different reviewer surfaces (diagnostics panel, health, lint gate) — worth consolidating so the shell's Publish action opens the same review surface.

### 1.3 What is NOT duplicated (dispelling the audit checklist)

- **Rendering engine**: single `compile.ts` mirrored to Deno with byte-parity tests. Guarded by `no-country-tokens`, `no-payslip-lines-in-certificates` ESLint rules and architecture tests.
- **Preview**: single `CertificateHtmlSurface` (paged.js iframe) used by both preview panes.
- **Validation**: single edge function + shared JSON-Schema registry (`pack_rule_type_schemas`).
- **Diff / versioning**: single `PackDiffView` + `VersionCompareCard` + `pack_upgrade_proposals` flow.
- **Governance**: single `PublisherGovernanceEditor` reading `pack_publisher_grants`.
- **Token registry**: single `pack_token_registry` with `pack_id IS NULL` for platform, per-pack rows for country packs.
- **Theme**: `template.theme` is the single presentation surface — engine reads CSS variables only.

The `docs/adr/0056-localization-publisher-parity.md` and `mem://features/certificate-rendering` already document these invariants.

## 2. Enterprise-pattern reference (short)

Odoo, Dynamics 365, NetSuite and Salesforce all converge on the same pattern:
- **One authoring surface** with role-gated capabilities (Odoo Studio; D365 Power Apps maker portal; Salesforce Setup with Profile-gated actions).
- **Layered data model**: base pack (immutable, versioned) + tenant overlay (mutable, upgrade-aware). Odoo's `ir.model.data noupdate` + Studio customizations; Salesforce's Managed Package + Subscriber Overrides; SAP's Client 000 vs Client 100.
- **Upgrade proposals**: publisher ships a new version, tenants get a diff-driven acceptance queue (Salesforce Package Upgrades; Odoo module upgrade with `--i18n-overwrite` opt-outs). We already implement this via `pack_upgrade_proposals`.
- **Preview parity**: the preview MUST run the exact filing/print pipeline (SAP Smart Forms, Odoo QWeb, Workday BIRT). We already do — same `compile()` in browser and edge.
- **Publisher certification / 4-eyes**: enterprise tier only (ADR 0056 P2.d). Deferred, correctly.

Our architecture already matches these patterns — the gap is UX consistency, not engine plurality.

## 3. Target architecture (delta from today)

Keep the current engine untouched. Collapse the surface into one entry per role:

```text
                    ┌─────────────────────────────────────────────┐
                    │        PackEditorShell (single shell)       │
                    │  mode = admin | tenant                      │
                    │                                             │
                    │  ┌──── Pack list ────┐ ┌── Version rail ──┐ │
                    │  │                   │ │                  │ │
                    │  │                   │ │  Entity tabs:    │ │
                    │  │                   │ │   Rules          │ │
                    │  │                   │ │   Templates ◄────┼─┼── new: override-aware
                    │  │                   │ │     · pack row   │ │    ("Default / Customized vN /
                    │  │                   │ │     · overrides  │ │     Out-of-date") — same tab
                    │  │                   │ │   Certificates   │ │    for admin + tenant
                    │  │                   │ │   Returns        │ │
                    │  │                   │ │   Governance     │ │
                    │  │                   │ │   Health         │ │
                    │  │                   │ │   Publish (same  │ │
                    │  │                   │ │     review UI)   │ │
                    │  └───────────────────┘ └──────────────────┘ │
                    └─────────────────────────────────────────────┘
                                        │
                                        ▼
                    ┌─────────────────────────────────────────────┐
                    │  Editor route (full-page) — shared by both  │
                    │  /localization/:packId/:kind/:code/edit     │
                    │    · admin  → writes pack row               │
                    │    · tenant → writes override row           │
                    │  Same CertificateTemplateEditor /           │
                    │  ReturnTemplateEditor components.           │
                    └─────────────────────────────────────────────┘
```

Key rules:
- No more sheet-vs-full-page split. Both roles get the full-page editor route.
- `Templates.tsx` (tenant) is deleted; its override lifecycle moves into `PackEntityTabs` (Templates/Certificates/Returns tabs) behind a shared `useResolvedTemplate(kind, code)` hook that returns `{ effective, source: 'pack'|'override', outOfDate }`.
- `AdminLocalizationPackPublishPage` becomes the same "Publish review" panel the shell already opens — one component, one entry.
- Capabilities are gated inside shared components by `mode` and `pack_publisher_grants` — never by rendering a different tree.

## 4. Phased plan (debt removal, not stacking)

Each phase is independently shippable and leaves the codebase healthier than it found it. No new engine. No new preview. No new validator.

**Phase 1 — Unify the editor mount (D1)**
- Extract the full-page route shell from `AdminLocalizationCertificateEdit.tsx` into `src/features/localization/routes/CertificateEditorRoute.tsx`.
- Add a matching tenant route `/settings/payroll/localization/:packId/certificates/:code/edit` that mounts the same route component with `mode="tenant"` and swaps the persistence adapter to the override hook.
- Update `PackEntityTabs` "Edit" actions to navigate to this route for both modes; drop the `WorkflowSheet` mount path for certificates.
- Same treatment for return templates (`ReturnTemplateEditor`).
- Guard test: architecture test that fails if `CertificateTemplateEditor` / `ReturnTemplateEditor` is mounted inside a `WorkflowSheet` anywhere.

**Phase 2 — Override-aware Templates tab (D2 + D3)**
- Introduce `useResolvedTemplate(kind, code)` in `features/localization/hooks/` that joins pack row + override row and returns `{ body, layout, source, packVersion, isOutOfDate, overrideId? }`.
- Extend `PackEntityTabs` Templates/Certificates/Returns tabs to render the "Default / Customized vN / Out-of-date" pill and Reset action currently in `Templates.tsx`.
- Delete `src/pages/hr/payroll/Templates.tsx`; redirect `/hr/payroll/templates` → `/hr/payroll/localization` (which already mounts `PackEditorShell`).
- Update navs (`src/apps/hr/shared/navs.ts`) and remove `TemplateOverride`-specific UI code that becomes dead.

**Phase 3 — One publish review surface (D4)**
- Convert `AdminLocalizationPackPublishPage` into `PackPublishReview` living in `features/localization/components/`.
- Shell's Publish action opens it (drawer OR route — pick one; route recommended for parity with Phase 1).
- Route `/admin-management/localization-packs/:packId/publish` remains, but renders the same component the shell opens.
- Health, diagnostics, lint gate, diff-since-last-published all consolidated into that component's tabs — remove the mini publish dialog inside the shell.

**Phase 4 — Guardrails**
- Architecture test enforcing `PackEditorShell` is the sole entry point for pack listing/versions (fails if another page queries `localization_packs` directly for a listing UI).
- Architecture test enforcing tenant + admin routes both mount the same editor route component.
- Update `docs/adr/0056` with the "single shell" invariant so future work doesn't re-fork.
- Update `mem://features/certificate-rendering` to add: "PackEditorShell is the only pack authoring surface; role differences are `mode` + `pack_publisher_grants`, never a parallel component tree."

**Deferred (already tracked in ADR 0056 P2.a–d, do not fold in here)**
- Dependency graph, semantic diff, end-to-end pack simulator, 4-eyes review.

## 5. Technical notes

- No engine, preview, validator, storage-schema or edge-function changes are required for Phases 1–3. Only routing, `PackEntityTabs`, and a new resolver hook.
- Override write paths (`useSaveTemplateOverride`, `useResetTemplateOverride`) stay as-is; they become internal implementations of the resolver hook's mutation surface.
- `WorkflowSheet` is retained for smaller edits (rule form, token form, governance grants) — the sheet-vs-page rule becomes "canvas surfaces → route, form surfaces → sheet".
- ESLint / architecture tests to add:
  - `no-workflowsheet-wrapping-canvas-editor`
  - `single-pack-shell-entry`
- Estimated code delta: ~700 lines deleted (`Templates.tsx` + duplicated publish page glue), ~250 lines added (resolver hook + route wiring + tests). Net reduction.

## 6. Non-goals for this plan

- Not touching the rendering engine, Theme, AST v3/v4, GridDesigner, or paged.js pipeline.
- Not changing RLS, pack storage, or the upgrade-proposal model.
- Not implementing ADR 0056 P2 items (dependency graph, semantic diff, simulator, 4-eyes).
- Not adding new preview surfaces (mobile / thermal / multi-currency) — separate track if requested.

## 7. Answer to the framing question

**Are Platform Admin and Tenant on the same architecture?** Yes — one engine, one editor family, one preview, one validator, one publishing pipeline, one governance model. The perceived duplication is three UX-level divergences (D1, D2, D4) and one missing resolver hook (D3). This plan removes all four without rebuilding anything.

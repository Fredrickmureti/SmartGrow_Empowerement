# ADR 0063 — Localization Preview Renderer Registry

**Status:** Accepted — 2026-07-16
**Owners:** Platform / HR-Payroll (Localization)
**Relates to:** ADR 0010 (pack versioning + tokens), ADR 0036 (country-
agnostic payroll completion), ADR 0056 (deferred publisher parity),
`mem://features/certificate-rendering`

## Context

The Localization Publishing Editor mounts the same authoring shell for
platform admins and tenants (certificate editing already unified;
return editing unified in this ADR). Previews were dispatched via ad-
hoc `switch` statements at every consumer:

- `ReturnFormatPreview` dispatched by `meta.submission_format.kind`,
- `LocalizationPreviewWindow` dispatched by `PreviewKind`,
- `CertificatePreviewPane` hard-selected the HTML paged path,
- `ReturnPreviewPane` rendered PDF via hand-drawn pdf-lib cells.

That produced three concrete problems:

1. **PDF-first bias.** CSV/XLSX/XML/JSON returns rendered as an empty
   PDF because the editor toggled a `renderer: "v2-returns"` flag by
   default. Publishers saw a PDF preview for a template that would
   never emit a PDF at runtime (e.g. KE `P10 (iTax CSV)`).
2. **Two renderers for one class of artefact.** Certificates rendered
   via HTML + CSS Paged Media (`compile()` → paged.js); returns used
   hand-drawn pdf-lib. Any parity concern applied twice.
3. **Country leakage in shared preview.** `KE_RETURN_PREVIEW_PAYLOAD`
   fed the preview and the bank-export sample rows, so a Ghana or SA
   publisher previewing their own pack saw Kenya PINs.

## Decision

### 1. Single renderer registry

All preview dispatch flows through `resolveReturnRenderer(formatKind)`
and `resolvePopOutRenderer(kind, payload)` in
`src/features/localization/lib/preview/rendererRegistry.tsx`. The
registry maps `(artefact × formatKind) → descriptor`; every consumer
delegates to it — no `switch` on `submission_format.kind` outside the
registry.

Dispatch rule (deterministic):

1. `meta.outputs[]` (`OutputsCard`) is the ground truth for what the
   runtime emits. The primary output (`role_hint === "human_readable"`
   else first) drives the preview.
2. Legacy rows without `outputs[]` fall back to
   `meta.submission_format.kind` (returns) or the artefact's implicit
   type (certificates → `pdf`).
3. Missing registry entry → explicit "no preview available for
   `<format>`" surface, never a silent fallback.

### 2. One renderer per artefact class

Returns and certificates share the country-agnostic
`certificate-engine` compile pipeline (see
`mem://features/certificate-rendering`). The return editor adapts its
body to a `CertificateTemplateV3` via
`src/features/localization/lib/preview/returnToAst.ts` and hands off to
`CertificateHtmlSurface`. pdf-lib is forbidden in localization preview
code by ESLint rule `no-pdf-lib-in-localization-preview`. The
`renderer: "v2-returns"` field is auto-stamped when the primary output
is PDF — publishers no longer see or toggle the "v2" flag directly.

### 3. Country-agnostic sample payload

All preview surfaces derive their sample from
`src/features/localization/lib/preview/samplePayload.ts`. Country-
specific values (PIN formats, statute names, rule codes) come from
`pack_token_registry.sample_value` keyed by `pack_id`. ESLint rule
`no-country-fixture-in-shared-preview` prevents country-prefixed
fixture imports in `components/preview/**` and `lib/preview/**`.

### 4. Unified editor shells

Tenant certificate and tenant return template edits both mount the
shared full-page route shell (`CertificateEditorPage`,
`ReturnEditorPage`) with an override-writing persistence adapter. The
in-drawer `WorkflowSheet` mounts for template editing are removed. The
editor, preview engine, renderer registry, and detached pop-out are
shared; the only differences between admin and tenant are:

- persistence adapter (pack row vs override row),
- capability to edit legal metadata (admin only),
- publishing rights (admin publishes pack, tenant overrides only).

### 5. Broadcast lifecycle

`previewBroadcast.ts` gains `publishPreviewHeartbeat` and
`clearPreview`. Editors emit a heartbeat every 5s and clear their
payload on unmount so the pop-out can distinguish "editor still open"
from "editor closed" and never flashes stale content when a new
template opens in the same tab.

## Consequences

**Positive**

- One dispatch surface — new artefacts (ISO 20022 pain.001, EDIFACT,
  new statutory forms) plug in by registering a `(kind, formatKind)`
  entry, not by editing the preview panes.
- Certificates and returns share one paged renderer — parity work
  benefits both.
- Country-agnostic previews restore trust for non-KE publishers.

**Deferred cost**

- Server-side PDF for returns (edge function
  `generate-statutory-return`) still uses `_shared/pdf/returnRenderer`
  and will migrate to the paged pipeline in a follow-on ADR, after
  Cloudflare Browser Rendering lands for certificates.
- Existing `payroll_return_templates` rows carrying
  `body.renderer = "v2-returns"` continue to work unchanged; the flag
  is now derived from the declared output, so a future data migration
  can drop it without touching the runtime.

## Out of scope

- Multi-language editor UI (platform i18n track).
- Publisher marketplace (separate ADR).
- Section AST vs certificate AST unification at the persistence layer
  — the preview adapter is the interim bridge; a native return AST
  land in a follow-up when at least two country packs need it.
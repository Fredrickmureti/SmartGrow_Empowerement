# Enterprise Document Rendering, Preview, Print & Delivery — Convergence Roadmap

Authoritative status file. Update after every completed implementation.

Last updated: 2026-08-06 (Phase 3a complete)

## Architectural vision

One business record → one frozen snapshot (`document_records.snapshot`) → one
rendering engine (`supabase/functions/_shared/rendering/*`) → one canonical
artifact per (document, medium, template version) in `document_artifacts`.
Disposition — preview, print, email, export, archive — **selects** an artifact.
It never selects a renderer, never re-reads live rows, and never draws its own
layout.

Client seams (do not bypass):
- `src/services/printing/render.ts` — the only client caller of `render-document`.
- `src/services/exports/documentExport.ts` — exports go through the render seam.
- `src/services/documents/snapshots/*` — snapshot builders (kind → frozen blob).

## Phase status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Email consumes canonical artifacts | **Done & verified** |
| 2 | CSV / XLSX exports become first-class rendering mediums | **Done & verified** |
| 3a | `generate-document` is snapshot-first (canonical short-circuit) | **Done & verified** |
| 3b | Retire legacy `fetchX` projections per kind as builders land | Pending — **next** |
| 4 | Replace React/HTML statement + POS previews with the canonical artifact viewer | Pending |
| 5 | ESLint rules + architecture ratchet closing the drift surface for good | Pending |

## Completed and verified

### Phase 1 — Email
- `supabase/functions/_shared/documents/canonicalPdf.ts`: resolves the canonical
  PDF — archived `document_artifacts` bytes first, then a render of the frozen
  snapshot via `render-document`, then `null` (caller falls back to legacy).
- `send-document-email` attaches canonical bytes; `encodeBase64` replaces
  `btoa(String.fromCharCode(...))` (stack overflow on large PDFs).
- Fixed a latent crash: undefined `businessRow` in the report-email branch.

### Phase 2 — Tabular exports
- `_shared/exports/snapshotToTable.ts` — one snapshot → table projection
  (transaction statements and item documents), honouring `hide_amounts`.
- `_shared/rendering/renderers/csv.ts`, `xlsx.ts` registered as mediums in
  `types.ts` + `mediumRegistry.ts`; `render-document` serves them.
- `documentExport.ts` no longer calls `fetch` — it resolves the document record
  and uses `renderDocumentRecord`.

### Phase 3a — Snapshot-first legacy generator
- `generate-document/index.ts`: after org-membership **and** subscription
  entitlement gating, PDF requests attempt `resolveCanonicalPdf`. When a
  `document_records` row exists, the archived/frozen bytes are returned with
  `X-Document-Canonical-Source` / `X-Document-Record-Id` headers. Kinds with no
  record fall through to the legacy fetcher unchanged; a resolver failure is
  logged and falls back (a print is never failed by the canonical path).
  Not short-circuited by design: `escpos` / `zpl` / `csv`, thermal-width PDF
  previews, and `force_refresh_settings` reprints.
- Guard: `src/test/architecture/legacy-generator-snapshot-first.test.ts`
  (resolver used, PDF-only, after tenancy+entitlement, fallback preserved).
- Closed a pre-existing coverage hole: `wmsReturn.ts` had no case in
  `src/test/documents/snapshot-contract.test.ts` — added.

Verification run: `legacy-generator-snapshot-first`,
`document-renderer-single-transport`, `printing-architecture`,
`src/test/printing/**`, `src/test/documents/**`, `src/test/pos/stage-b-receipt-snapshot`
— all green.

## Pending work

### Phase 3b (next) — retire legacy projections per kind
1. Inventory which `FETCHER_MAP` entries in `generate-document` still have no
   snapshot builder. Known gap: **vendor credit notes** (no document kind at
   all today — they are only rows inside vendor statements).
2. For each gap: add a builder under `src/services/documents/snapshots/`, wire
   `ensureDocumentRecord` at the module's submit/issue point, add a case to
   `snapshot-contract.test.ts` and a field-for-field parity test against the
   legacy fetcher (see `src/test/documents/*-snapshot.test.ts` for the pattern).
3. Only once a kind is fully record-backed, delete its `fetchX` and
   `FETCHER_MAP` entry. Never delete a fetcher whose kind can still arrive
   without a record.

### Phase 4 — preview convergence
`src/components/purchases/VendorStatementPreview.tsx` and the POS summary tabs
are hand-built React/HTML that can drift from the PDF. Replace with the
canonical artifact viewer (`render-document` → PDF → preview surface via
`src/services/printing/previewSurface.ts`).

### Phase 5 — ratchet
ESLint rules extending `eslint-rules/no-direct-generate-document-in-pages.js`
to forbid any new direct edge invocation, plus an architecture test that fails
when a new `fetchX` is added to `generate-document`.

## Instructions for the next agent

1. **Verify before building.** Re-run the suites listed under *Verification run*
   above, then read `generate-document/index.ts` around the Phase 3a block and
   `_shared/documents/canonicalPdf.ts`. Confirm: the short-circuit sits after
   both tenancy gates, non-PDF formats are untouched, and the legacy fallback is
   still reachable. Confirm `send-document-email` and `documentExport.ts` still
   route through the canonical seam.
2. **Then resume at Phase 3b, step 1** — do not start Phase 4 or 5 first, and do
   not open unrelated modules.
3. Bring each kind to a production-ready state (builder + record wiring +
   parity test + fetcher removal) before starting the next kind. No partial
   onboarding, no orphaned builders.

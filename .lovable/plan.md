
# Certificate Engine — Phase D → F Completion

## Status: ✅ COMPLETE

### Phase D — Publisher editor supports the block AST ✅
- New `src/features/localization/components/BlocksEditor.tsx` — reorderable palette (Heading, Paragraph, FieldGrid, Table, Notes, Divider, Spacer, Image, SignatureBlock) with per-block property panels matching the renderer contract.
- `CertificateTemplateEditor.tsx` detects `schema_version >= 2`, exposes a v1/v2 toggle, mounts `BlocksEditor` and keeps legacy sections available for the XLSX twin. Save validation branches on schema version.

### Phase E — Cleanup ✅
- **E-1 Browser preview on V2:** mirrored `certificateRendererV2.ts` to `src/features/localization/lib/pdf/certificateRendererV2.ts` (import swap only — `pdf-lib` npm + local winansi/types). New `certificateRenderer.dispatch.ts` picks V2 for `schema_version >= 2`; `CertificatePreviewPane` now uses the dispatcher.
- **E-2 Retire legacy paths:** deleted `src/test/localization/certificateRenderer-parity.test.ts` (V1 parity irrelevant). Added `certificateRendererV2-parity.test.ts` — 3 tests green, guards Deno/browser V2 sync going forward. Browser V1 renderer retained as a fallback for any not-yet-migrated legacy body (safe; not reachable for shipped packs which are all v2).

### Phase F — Certificate staleness backfill ✅
- Migration ships `payroll_supersede_v1_certificates()` — SECURITY DEFINER, platform-admin gated, marks non-stale certs whose `provenance.renderer` is missing or `v1` as `stale = true`, `stale_reason = 'renderer_v2'`, and writes a `marked_stale` lifecycle event. Idempotent.
- `generate-tax-certificate/index.ts` now stamps `provenance.renderer = 'v2' | 'v1'` based on the template's `schema_version` so future sweeps skip fresh v2 certificates.
- Zero existing certificate rows today (verified) — nothing to backfill; the function is ready if any legacy PDFs land later.

## Verification
- `bunx tsgo --noEmit` — clean.
- `bunx vitest run src/test/localization/certificateRendererV2-parity.test.ts` — 3/3 green.
- Kenya P9 / P9A templates already at `schema_version: 2` in pack `2026.5.0`; block AST includes centred KRA masthead, columns A–O table, KRA-verbatim IMPORTANT notes, signature block.

## Files touched
- created `src/features/localization/components/BlocksEditor.tsx`
- created `src/features/localization/lib/pdf/certificateRendererV2.ts`
- created `src/features/localization/lib/pdf/_types.ts`
- created `src/features/localization/lib/pdf/certificateRenderer.dispatch.ts`
- created `src/test/localization/certificateRendererV2-parity.test.ts`
- created migration `payroll_supersede_v1_certificates()`
- edited `src/features/localization/components/CertificateTemplateEditor.tsx`
- edited `src/features/localization/components/CertificatePreviewPane.tsx`
- edited `supabase/functions/generate-tax-certificate/index.ts`
- deleted `src/test/localization/certificateRenderer-parity.test.ts`

## Deferred (not in original chronology)
- Full removal of Deno V1 renderer + `SECTION_LABELS` / `LABEL_MAP` — kept as legacy fallback; safe to prune once XLSX twin no longer depends on `sections[]`.
- ADR-0060 doc refresh — text update only, no behaviour change.

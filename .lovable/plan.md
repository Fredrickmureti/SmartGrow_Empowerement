
# Remaining Phases D → F — Completion Plan

The engine (Phase A), schema (Phase B) and Kenya migration (Phase C) are done. What remains from the original chronology:

## Phase D — Publisher editor supports the block AST

**File:** `src/features/localization/components/CertificateTemplateEditor.tsx` (697 lines today, section-based).

- Detect `body.schema_version >= 2` and switch the editor into **Blocks mode**.
- Add a block palette: **Heading, Paragraph, FieldGrid, Table, Notes, Divider, Spacer, Image, SignatureBlock** — same list the renderer supports.
- Reorderable block list (drag handle, up/down, delete, duplicate).
- Per-block property panels:
  - Heading: `text`, `level` (1/2/3), `align`.
  - Paragraph: `text`, `emphasis`.
  - FieldGrid: `title`, `columns`, `data_source` (employer/employee), field rows (`key`, `label`, `emphasis`).
  - Table: `title`, `data_source` (monthly_breakdown/ytd_rows), `group_by`, `columns[]` (`key`, `header`, `width`, `align`, `format`), `footer` (`aggregate`, `label`), `options` (striped, repeat_header, wrap, padding).
  - Notes: `title`, `paragraphs[]`.
  - Divider/Spacer: size only.
  - Image: `src` (asset id or base64), `width`, `height`, `align`.
  - SignatureBlock: `slots[]` (`caption`, `sub_caption`).
- Keep the legacy `sections[]` editor available on the same body (read-only tab) so the XLSX twin can still be tuned during the transition.
- Live preview pane continues to use `CertificatePreviewPane.tsx`; the pane's dynamic import is switched to a shared V2 entry (see Phase E-1).

## Phase E — Cleanup, in two safe steps

**E-1. Browser preview switches to V2 (unblocks deletions).**
- Extract the V2 renderer's pdf-lib code into a runtime-neutral module and add a `browser` re-export at `src/features/localization/lib/pdf/certificateRendererV2.ts` that dynamically loads pdf-lib via ESM.
- Update `CertificatePreviewPane.tsx` and `kePayrollFixture.ts` to import types/functions from the V2 module.
- Keep the Deno path as the single source of truth for behaviour; browser module is a thin adapter.

**E-2. Retire the legacy paths.**
- Delete `src/features/localization/lib/pdf/certificateRenderer.ts` (browser V1 duplicate) and `src/features/localization/lib/pdf/winansi.ts` if unused after E-1.
- Delete `src/test/localization/certificateRenderer-parity.test.ts` (no longer meaningful — parity is guaranteed by shared import).
- Remove `SECTION_LABELS`, `LABEL_MAP`, relief defaults, and the section-type switch from `supabase/functions/_shared/pdf/certificateRenderer.ts`, leaving only a thin dispatcher: if `schema_version >= 2` → V2; else raise a clear "legacy body — republish template" error. All shipped packs are already v2.
- Update `supabase/functions/_shared/xlsx/certificateXlsxRenderer.ts` and `certificateLintFixture.ts` to import `CertificatePayload` / `CertificateTemplate` types from `certificateRendererV2.ts`.
- Delete `certificateRenderer_golden_test.ts` if it locks V1 output; otherwise re-baseline against V2.
- Update ADR-0060 to record the completion of the renderer collapse.

## Phase F — Certificate staleness backfill

- No `payroll_tax_certificates` rows exist yet (verified: `total = 0`), so there is nothing to supersede today.
- Ship a one-shot migration `payroll_supersede_v1_certificates()` that marks every certificate whose `provenance->>'renderer'` is missing or equal to `v1` as `stale = true`, `stale_reason = 'renderer_v2'`, and writes a `marked_stale` event to `payroll_tax_certificate_events`. Safe to run against an empty table today and correct if any legacy PDFs land later.
- Have `generate-tax-certificate` stamp `provenance.renderer = 'v2'` on new certificates so future sweeps skip them.

## Verification

- `bunx vitest run` — new block-editor unit tests + updated preview snapshot.
- `deno test` on `_shared/pdf/certificateRendererV2_test.ts` — unchanged, still green.
- Manual: open the Kenya P9 template in the editor → confirm Blocks mode loads, columns A–O are all editable, live preview matches the KRA 2025 layout.
- Confirm existing architecture guards (`no-payslip-lines-in-certificates`, publishing gates, canonical-source test) all still pass after the V1 dispatcher is thinned.

## Out of scope (unchanged from ADR-0060)

- HTML/CSS renderer swap.
- Marketplace publishing UX.
- Government logo assets — still publisher-supplied via `Image`.

## Technical notes

- The V2 renderer already draws every block type the editor exposes, so Phase D is UI-only.
- The browser adapter in Phase E-1 exists to avoid Deno-specific imports (`https://esm.sh/pdf-lib@...`) leaking into Vite's bundler; the code path is otherwise identical.
- Phase F's SQL is idempotent and safe to run repeatedly; the `provenance.renderer` marker is what stops it from re-flagging fresh certificates.

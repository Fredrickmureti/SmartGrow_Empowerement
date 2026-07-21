
# Enterprise Printing Architecture — Continuation Plan

## Verification of prior work (what I found in the codebase)

Confirmed against source, migrations, and drivers — not against the previous engineer's log:

**Landed (Phases 7–10)**
- `supabase/migrations/20260721001823_…sql` creates `public.media_profiles` (with grants, RLS, org auto-seed trigger `tg_org_seed_media_profiles`), extends `printer_profiles` with `command_language`/`dpi`/`margins_mm`/`supported_media_ids[]`/`capabilities[]`, adds `label_templates.media_profile_id`, replaces the unique index with `(org_id, branch_id, template_key, media_profile_id)`, and rewrites `resolve_label_template` to a 4-arg signature with media fallback (exact media → NULL → default).
- `20260721002219_…sql` rewrites `seed_default_label_templates` to link each seed row to a media profile and strip `^PW/^LL` from every body.
- `src/services/printing/labelDispatch.ts` resolves the printer's `supported_media_ids[0]` (or an explicit override), passes `p_media_profile_id` to the RPC, and carries `mediaWidthMm/mediaHeightMm/dpi` through the driver payload; EPL bodies are shipped as `{ epl }` instead of pre-encoded bytes.
- `electron/hardware/drivers/ZplLabelDriver.ts` and `EplLabelDriver.ts` inject `^PW/^LL` / `q/Q` from the media payload; the browser/LAN-agent fallback (`src/services/hardware/BrowserHardwareAdapter.ts`) mirrors the same envelope injection so scaling behaves identically on all three transports.

**Not yet landed**
- Phase 11 — media & printer capability admin UI (`/platform/hardware` surface has `HardwareDevices`/`HardwareTopology`/`HardwareDiagnostics` but no media-profile or capability management; label template editor has no media picker).
- Phase 12 — architecture guardrail tests, ADR `0087-media-and-printer-capability.md`, and the closure rows in `docs/audit/2026-07-20-enterprise-output-platform.md`.

**Verification gaps I will still close before shipping (Phase V)**
Prior work claims are believable but a few must be proven end-to-end, not just spot-read:

- `resolve_label_template` fallback ordering (exact media → NULL → default) actually resolves — write a SQL-shaped unit that seeds three variants and asserts the pick.
- Every seeded template body (existing rows + fresh org seed via `tg_org_seed_media_profiles`) is envelope-free: grep for `^PW`, `^LL`, `^q\d+`, `^Q\d+` in `label_templates.body` after seeding — must be zero rows.
- The Electron driver, LAN-agent driver, and Browser adapter all produce byte-identical envelopes for the same media+dpi (parity, not just presence).
- `printer_workflow_bindings` → chosen printer → `supported_media_ids[0]` resolution never silently returns `null` at dispatch time; when no media is resolvable, dispatch fails loud with a structured error (the plan requires this — the current code path needs a targeted test).
- Backfill: pre-existing `label_templates` rows that had inline `^PW/^LL` are rewritten by the Phase 10 migration; confirm via `select count(*) from label_templates where body ~ '\^PW|\^LL|^q[0-9]|^Q[0-9]'` returning 0.

## What I will build

### Phase V — Verification harness (do first, before any new code)

1. Add `src/test/printing/media-profile-resolution.test.ts` — pgTAP-style assertions via the existing `supabase/tests/` harness that seed 3 templates (media A / media B / NULL) and assert `resolve_label_template` returns the exact match, then NULL fallback, then org default.
2. Add `src/test/printing/label-template-body-envelope-free.test.ts` — reads `seed_default_label_templates` source + every migration file that inserts into `label_templates` and asserts no `^PW / ^LL / ^q<n> / ^Q<n>` literal appears in any inserted body.
3. Add `electron/hardware/drivers/__tests__/label-envelope-parity.test.ts` — feeds the same `{ mediaWidthMm, mediaHeightMm, dpi }` through `ZplLabelDriver`, `EplLabelDriver`, and the browser adapter's envelope helper; asserts the emitted prefix bytes are exactly the expected `^PW<dots>\n^LL<dots>\n` / `q<dots>\nQ<dots>,24\n` regardless of transport.
4. Add `src/test/printing/label-dispatch-requires-media.test.ts` — invokes `printLabelByTemplate` against a printer profile whose `supported_media_ids` is empty and no override is passed; asserts the dispatch throws a structured `NO_MEDIA_RESOLVED` error, not a silent unscaled print.

If any of these fail, the fix is part of this same wave — verification is not optional and the plan does not advance to Phase 11 until it is green.

### Phase 11 — Admin UI for media & printer capability

Under `src/apps/platform/hardware/` (existing HardwareAppLayout / routes.tsx):

- `HardwareMedia.tsx` (new route `/platform/hardware/media`): CRUD table over `media_profiles` — `code`, `name`, `kind (roll|sheet|A-series|receipt)`, `width_mm`, `height_mm`, `orientation`, `gap_mm`. Uses the canonical Records dialog primitives (no ad-hoc dialogs — respects the design-system rule).
- Extend `HardwareDevices.tsx` printer detail sheet with a "Hardware capability" section: `command_language` (select: ZPL / EPL / ESC-POS / PDF), `dpi` (203 / 300 / 600), `margins_mm` (jsonb editor), and a multiselect for `supported_media_ids`. These write the printer_profile row, not device_assignments.config.
- Extend the label template editor (find the existing surface at `src/pages/settings/**` or `src/apps/**/labels/**`; if none exists, add a minimal one under `/platform/hardware/label-templates`) with a media picker whose live preview scales the canvas to the picked `(width_mm, height_mm)` at the picked printer's DPI, so operators see the real output size.
- Add `nav.ts` entries. Guarded by the same admin role check the rest of the platform-hardware routes use.

### Phase 12 — Architecture guardrails, ADR, audit closure

- New arch tests (source-inspection style, matching the existing `hardware-*` test pattern):
  - `label-templates-have-no-envelope.test.ts` — scans every `.sql` under `supabase/migrations/` for `INSERT INTO … label_templates …` bodies and asserts no `^PW/^LL/q<n>/Q<n>`.
  - `printer-profile-hardware-shape.test.ts` — asserts driver code reads `command_language` / `dpi` from `printer_profiles` (via the resolved payload) and never from `device_assignments.config.{dpi,widthMm,heightMm}`.
  - `media-profile-required-on-label-render.test.ts` — asserts `printLabelByTemplate` refuses to dispatch when no media resolves.
- ADR `docs/adr/0087-media-and-printer-capability.md` — records three-way ownership (media / printer capability / template content), the driver-owns-envelope contract, deprecates the mm fields on `label_templates` (kept as legacy metadata for now), and supersedes the relevant section of ADR 0086.
- Update `docs/audit/2026-07-20-enterprise-output-platform.md` — mark D7–D11 closed with links to the migrations, driver files, admin routes, and guardrail tests.
- Delete/soft-remove the now-legacy `printer_profiles.paper_format` reads from code (keep the column). Any remaining reader is replaced by `supported_media_ids[0]` lookup.

## Explicit non-goals (unchanged from prior plan)

- No change to the A4/PDF pipeline — `_shared/pdf` remains single-source.
- No change to the POS receipt `Line[]` pipeline — `receipt/lines` remains single-source.
- No emulator/margin/font tweaks. Symptom-level patches are still rejected.
- No change to `HardwareClient`, transport, or agent wire protocol.

## Technical details (for the record)

- `media_profiles.kind` values used: `roll`, `sheet`, `A-series`, `receipt`.
- Envelope math (both drivers + browser adapter): `dpmm = dpi / 25.4`; `widthDots = round(mediaWidthMm * dpmm)`; identical rounding across drivers is what the parity test locks.
- Fallback order for `resolve_label_template(p_org_id, p_template_key, p_branch_id, p_media_profile_id)`:
  1. `(branch_id = p_branch_id, media_profile_id = p_media_profile_id)`
  2. `(branch_id = p_branch_id, media_profile_id IS NULL)`
  3. `(branch_id IS NULL, media_profile_id = p_media_profile_id)`
  4. `(branch_id IS NULL, media_profile_id IS NULL)`
- Dispatch order in `labelDispatch.ts`: resolve printer via `printer_workflow_bindings` → read `supported_media_ids[0]` (or explicit override) → resolve template with media → attach `mediaWidthMm/mediaHeightMm/dpi` from resolved profile → driver injects envelope.

## Definition of done

1. Phase V harness green — proves prior claims, not just re-reads them.
2. Adding a new label size = one `media_profiles` row + one FK on the template. No code change.
3. Adding a new printer model = one `printer_profiles` row with `command_language`+`dpi`+`supported_media_ids[]`. No driver change.
4. Same content body renders correctly on 50×30, 80×50, and 102×152 mm across 203 and 300 dpi printers, and on all three transports (Electron / LAN agent / Browser).
5. No `label_templates.body` in the database or in any migration contains `^PW / ^LL / q<n> / Q<n>`.
6. Admin can create media profiles and set printer capabilities without touching code.
7. ADR-0087 published; audit `2026-07-20-enterprise-output-platform.md` marks D7–D11 closed.
8. All guardrail tests from Phases V + 12 green; existing 22 arch/parity tests remain green.


# Enterprise Printing Architecture — Audit Findings & Remediation Plan

## Verified current architecture (evidence, not assumption)

Pipeline in place (post ADR-0086 D1–D6):

```text
business event → generate-document (canonical fetcher)
              → canonical model (DocumentData | Line[] | label_templates row)
              → renderer  (_shared/pdf | receipt/lines | template body render)
              → driver    (ZplLabelDriver | EplLabelDriver | EscPos* | PDF)
              → transport (Electron / LAN agent / browser)
```

**What is already correct** (verified file:line, do NOT touch):

- Paged/A4 family: single `_shared/pdf` engine; every A4 document goes through `generateDocumentPdf` / `generateReportPdf` / `hrLetterPdf`. Guarded by `no-raw-pdf-lib-in-app` + `no-raw-pdf-lib-in-edge-functions`.
- Thermal/receipt family: single `receipt/lines.ts → Line[]` canonical, single ESC/POS renderer, guarded by `thermal-routing-architecture`, `parity_gate`, `escpos-parity`.
- Label templates: `label_templates` table + `resolve_label_template` RPC + `printLabelByTemplate` client entrypoint + `buildLabelZpl` server adapter — all read the same rows (D1 fix, `label-builder-has-no-hardcoded-zpl.test.ts`).
- Label drivers: `ZplLabelDriver` / `EplLabelDriver` are pure transports post-D6, no layout ops (`adr-0086-driver-side-label-layout-ownership.test.ts`).
- Statement client entrypoints on canonical `useDocumentPrint` (D3).

## Root cause of the "changing label size doesn't scale content" symptom

Confirmed by reading `label_templates` schema, `seed_default_label_templates`, `ZplLabelDriver.readConfig`, and `resolve_label_template`:

1. **Media is not a first-class concept.** Physical dimensions live redundantly in three unrelated places, none authoritative:
   - `printer_profiles.paper_format` — enum `a4|letter|a5|80mm|58mm` (business-ish, no mm, no dpi, no length).
   - `label_templates.width_mm/height_mm` — metadata only, never read by the renderer or driver.
   - `device_assignments.config.{widthMm,heightMm,dpi}` — read by `ZplLabelDriver.readConfig` but only stored, **never emitted** (no `^PW`/`^LL` inserted).
2. **Template bodies encode absolute dot coordinates** (`^PW640`, `^LL400`, `^FO20,20`, `A50,50,…`) hardcoded at seed time (`_shared/printing/zpl/builder.ts` history + `20260617213931_…sql:117-125`). A body seeded for `640×400` dots at 203dpi silently renders inside a `102×152 mm` roll — the label paper stretches, the content does not.
3. **Template key has no media dimension.** `label_templates` unique index is `(org_id, branch_id, template_key)`. You cannot register a `shelf_edge` template for `50×30 mm` *and* `100×150 mm` — only one per key. So the label is fundamentally single-media.
4. **`printer_profiles` describes a business paper, not hardware.** No `dpi`, no `command_language` (ZPL/EPL/ESC-POS), no `supported_media[]`, no `resolution_dpmm`. The driver's DPI comes from `device_assignments.config.dpi` — a per-device override, unbound to the printer profile it plays.
5. **The `resolve_workflow_printer` RPC** picks a printer profile but has no media-awareness. Two branches can bind different physical printers with different DPI to the same workflow and the same template will drift on the wire.

Net: the pipeline is canonical from `label_templates` on, but the layer *below* it (media + hardware capabilities) is missing. Every scaling/DPI complaint bottoms out here.

## Additional drift to close (verified, small)

- **D7 · Media not modeled.** No `media_profiles` table. Dimensions duplicated (see above). Adding a new label size today requires editing template bodies by hand.
- **D8 · `printer_profiles` conflates paper with hardware.** `paper_format` should describe supported media, not one paper choice. Missing `dpi`, `command_language`, `supported_media[]`, `margins_mm`, `capabilities`.
- **D9 · Envelope commands not emitted by driver.** `ZplLabelDriver` reads `widthMm/heightMm/dpi` from config but never issues `^PW`/`^LL`. `EplLabelDriver` is a raw passthrough. Result: template body's dot envelope wins — media choice is cosmetic.
- **D10 · Template key lacks media dimension.** `(org_id, branch_id, template_key)` — no `media_profile_id`. One template per business intent, forever.
- **D11 · `assignment.config` is an ad-hoc hardware source.** Same fields (dpi, widthMm) exist on the printer profile in enterprise systems (SAP output devices, Odoo IoT drivers, LS Central hardware profiles).

## Target architecture (mirrors SAP output management / Odoo IoT / LS Central)

Add exactly two first-class concepts and re-key labels on them; drivers become bytes+envelope emitters, not passthroughs.

```text
media_profiles          printer_profiles                label_templates
──────────────          ────────────────                ───────────────
id                      id                              id
org_id                  org_id                          org_id, branch_id
code (e.g. shelf_50x30) label                           kind, template_key
width_mm, height_mm     command_language ZPL|EPL|ESC    media_profile_id  ← NEW
orientation             dpi 203|300                     engine
gap_mm                  margins_mm                      body (uses tokens
kind roll|sheet|A-      supported_media_ids[]              only, no dot
                        capabilities[]                     literals — the
                        transport, address                 driver injects
                        driver key                         the envelope)
                                                        version, active

printer_workflow_bindings  (unchanged — still resolves the physical printer per workflow)
```

**Rendering contract change** (one line in the driver, one line in the template):

- Template body drops `^PW`/`^LL` / EPL `q`/`Q` header. It contains only content tokens (`^FO…^FD{{name}}^FS`).
- Driver reads the target `media_profile` + `printer_profile.dpi` and emits the envelope: `^PW<dots>` `^LL<dots>` for ZPL; `q<dots>\nQ<dots>` for EPL. Content is then placed *inside* a media-sized frame instead of a body-hardcoded frame.
- Same content template renders correctly on 50×30 mm, 80×50 mm, or 102×152 mm as long as the printer profile's `dpi` and `command_language` match.

## Phases (chronological, each self-contained)

### Phase 7 — Media as first-class

- Migration adds `public.media_profiles(id, org_id, code, name, width_mm, height_mm, orientation, gap_mm, kind)` with grants, RLS, updated_at trigger, seed of the platform defaults (`receipt_58`, `receipt_80`, `receipt_40`, `label_50x30`, `label_80x50`, `label_102x152`, `sheet_a4`, `sheet_letter`).
- Backfill: for each existing `label_templates` row with `width_mm/height_mm`, upsert a matching `media_profiles` row and set the new FK.

### Phase 8 — Promote `printer_profiles` to hardware

- Migration adds `command_language text CHECK IN (zpl|epl|escpos|pdf)`, `dpi int`, `margins_mm jsonb`, `supported_media_ids uuid[]`, `capabilities text[]`. Keep `paper_format` for backcompat but stop reading it in code (added as legacy).
- Deprecate reading `assignment.config.{dpi,widthMm,heightMm}` in drivers; drivers now read from the printer profile they're bound to (join in the exec dispatch path).

### Phase 9 — Re-key `label_templates` on media

- Migration adds `label_templates.media_profile_id uuid REFERENCES media_profiles`, drops the current unique index, adds `(org_id, branch_id, template_key, media_profile_id)` unique.
- Update `resolve_label_template` to accept `p_media_profile_id` with fallback (exact media → media-agnostic (NULL) → org default).
- Update `printLabelByTemplate` + `buildLabelZpl` to pass the resolved printer's media.

### Phase 10 — Driver emits envelope, not template

- Strip `^PW`/`^LL` (and EPL `q`/`Q`) from all seeded template bodies. Add a migration that rewrites bodies inserted by `seed_default_label_templates` and its backfill counterpart.
- `ZplLabelDriver.applyTransportCommands` gets a new job: compute `widthDots = round(mediaWidthMm * dpmm)` and prepend `^PW<widthDots>\n^LL<heightDots>\n` after `^XA`. Same for `EplLabelDriver` (`q<dots>\nQ<dots>,24\n`).
- Guardrail test: any `label_templates` body containing `^PW` / `^LL` / bare EPL `q\d+` fails the build — envelope is a driver responsibility now.

### Phase 11 — UI: media & printer capability admin

- Small admin surface under `/platform/hardware`: manage `media_profiles`, and on each printer profile pick `command_language`, `dpi`, `supported_media`.
- Label template editor gains a media picker; preview scales to the selected media so operators see the actual output size.

### Phase 12 — Guardrails & docs

- New arch tests:
  - `label-templates-have-no-envelope.test.ts` — no `^PW/^LL/^Q/^q` in any seeded body.
  - `printer-profile-hardware-shape.test.ts` — code reads `command_language`/`dpi` from `printer_profiles`, not from `device_assignments.config`.
  - `media-profile-required-on-label-render.test.ts` — `printLabelByTemplate` never dispatches without a resolved media.
- New ADR `docs/adr/0087-media-and-printer-capability.md` documenting the three-way ownership (media / printer capability / template) and superseding the mm-fields on `label_templates`.
- Update `docs/audit/2026-07-20-enterprise-output-platform.md` with D7–D11 rows and closures.

## Explicit non-goals

- No change to A4/PDF pipeline — already single-source.
- No change to POS receipt `Line[]` pipeline — already single-source.
- No change to `HardwareClient` chokepoint, transport layer, or agent wire protocol.
- No emulator/margin tweaks. Root cause is the missing media layer; symptomatic patches are rejected.

## Definition of done

1. Adding a new label size = insert one `media_profiles` row + reference it from an existing template. No code change, no template body edit.
2. Adding a new printer model = insert one `printer_profiles` row with `command_language`+`dpi`+`supported_media[]`. No driver change.
3. Same template body renders correctly on 50×30, 80×50, and 102×152 mm on both 203 and 300 dpi printers.
4. `label_templates.body` contains content tokens only — never `^PW`/`^LL`/`q`/`Q`.
5. Every guardrail from Phases 7–12 green.
==========================================================

PROGRESS
========================================
Migration succeeded. The 2175 linter warnings are pre-existing, unrelated to this change.

Summary of what landed this turn (Phase 10 completion):

labelDispatch.ts: Now resolves the printer's media profile (printer_profiles.supported_media_ids[0] or explicit mediaProfileId override), calls the media-aware resolve_label_template RPC, and carries mediaWidthMm/mediaHeightMm/dpi through the payload. EPL bodies are also now shipped correctly as { epl } instead of pre-encoded bytes.
BrowserHardwareAdapter.ts: The browser/agent fallback path now injects the ZPL ^PW/^LL and EPL q/Q envelope from the payload media hints — same behavior as the Electron main-process ZPL/EPL drivers, so labels scale correctly whether printing via Electron, LAN agent, or WebUSB.
Migration: Rewrote seed_default_label_templates to (a) link every default template to its media_profile_id, (b) emit envelope-free bodies so the driver is the single owner of paper geometry. Backfilled existing seeded rows to strip ^PW/^LL.
Verified: 22/22 arch + parity tests green, clean typecheck. Labels now scale to the media resolved from the printer profile end-to-end.
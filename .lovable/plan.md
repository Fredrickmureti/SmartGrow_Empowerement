## What's actually happening

Two independent bugs, both visible in your screenshot vs PDF:

**Bug 1 — Layout divergence (`#POS1-…` vs `No: POS1-…`)**
The shared row engine (`_shared/receipt/lines.ts:352`) emits `left("No: <number>")`. The legacy builder (`_shared/escpos/builder.ts:762`) emits `center("#<number>")`. The PDF you attached matches the shared engine; the Espresso stream matches the legacy builder. So somewhere in the wire path the bytes are still coming from `buildDocumentEscPos`, not `renderDocumentEscPos`. Candidates: cached artifact re-serve, `pos_receipt_preview` on a stale path, kitchen ticket route, agent-side re-render, or a second edge function. This has to be proven, not guessed.

**Bug 2 — 58 mm overflow**
The paper width has *two* sources of truth today: `pos_receipt_settings.paper_size` (tenant-level) and `printer_profiles.paper_format` (device-level). The engine resolves from settings, not from the profile, so when you set the profile to 58 mm the engine still renders at 80 mm and text overflows.

## How the majors (Square/Odoo/Toast/Star) solve this

1. **One renderer per format, gated by architecture tests** — no code path can produce ESC/POS bytes except through the canonical emitter. Enforced by grep-level "forbidden import" tests in CI.
2. **Byte-level golden snapshots** — every receipt shape has a checked-in `.escpos.bin` golden. Any drift = failing CI, with a human-readable diff.
3. **Device capability descriptor is the single source of truth for width** — `printer_profile.paper_format` overrides everything; document-level settings are only fallbacks. Star/Epson SDKs do exactly this.
4. **Emulator-in-CI** — headless Espresso-style renderer runs the golden bytes and diffs the rasterised output against a reference PNG. Catches "bytes look right but printer prints wrong" regressions (cutter, codepage, column clamp).
5. **Observability on the wire** — every print job carries an `X-Renderer` header + a `receipt_render_log` row recording (renderer version, width used, byte hash, source path). One SQL query answers "which pipeline produced this receipt".

## Plan

### Phase 1 — Prove which pipeline produced the Espresso bytes (no fix yet)

1. Add a debug header/log on every ESC/POS response in `generate-document`: `X-Renderer: shared-engine@<hash>` and one `console.log` line with `{ documentType, documentId, format, width, rendererPath, byteSha256 }`.
2. Reprint the exact receipt (`POS1-260720-0015`) to Espresso and capture the response header + edge-function log.
3. Also `curl` the persisted artifact row for that transaction and hash its bytes — if the served bytes ≠ freshly-rendered bytes, the artifact cache is the culprit.

This turns "we think X is happening" into a definitive answer before any code change.

### Phase 2 — Collapse the remaining ESC/POS producers

Based on Phase 1 findings, do exactly one of:
- If a cached legacy artifact is being reserved → invalidate legacy `escpos` artifacts on read (version mismatch) and re-render on demand.
- If a second code path (kitchen, drawer combo receipt, agent-side) is calling `buildDocumentEscPos` → route it through `renderDocumentEscPos` or delete it.
- If `pos_receipt_preview` still hits the legacy builder in some branch → remove that branch.

Then add an **architecture test** (`escpos-single-owner.test.ts`) that greps the whole repo and fails if anything except `renderDocumentEscPos.ts`, `parity_gate_test.ts`, and the legacy kitchen ticket importer references `buildDocumentEscPos`. This makes the regression uncatchable.

### Phase 3 — Fix the 58 mm overflow at the source of truth

1. Introduce `resolvePaperWidth({ profile, receiptSettings, requestOverride })` with a fixed precedence: `requestOverride > profile.paper_format > receiptSettings.paper_size > default("80mm")`. One function, one place.
2. Wire both the preview branch and the production branch in `generate-document` to call it. Delete the ad-hoc width resolution scattered around.
3. Assert in `renderDocumentEscPos` that `paper === profile.paper_format` when a profile is present; log a warning if they diverge (means a caller is bypassing the resolver).
4. Add three golden byte snapshots per document type (40 mm / 58 mm / 80 mm) with a max-line-width invariant test that fails if any line exceeds the column count.

### Phase 4 — Byte-level golden snapshots + emulator diff in CI

1. Check in `supabase/functions/_shared/escpos/__goldens__/pos_receipt_{40,58,80}.escpos.bin` produced from the canonical `goldenDoc` fixture.
2. Extend `parity_gate_test.ts` to also assert byte-equality against these files (currently it only checks internal parity between two shared-engine calls).
3. Add a tiny Deno "raster" test using the same character grid Espresso uses (fixed-width font, column count) that renders the bytes to a text canvas and asserts no line exceeds the paper width and no meta row falls outside the printable area.

### Phase 5 — Wire observability + operator visibility

1. Create `receipt_render_log(id, document_type, document_id, renderer, renderer_version, paper, byte_sha256, source_path, created_at)` with RLS + grants. Insert one row per ESC/POS response.
2. Surface the last renderer + byte hash on the printer profile page ("last print: shared-engine@abc123, 58 mm, 1,204 bytes"). One glance tells the operator whether their print came from the new pipeline.

## Technical notes

- **No new abstractions.** Everything lands inside the existing `_shared/receipt/` + `_shared/escpos/` boundary.
- **No behavioural change on the PDF path** — it already matches what we want. All work is on the ESC/POS path + the width resolver.
- **Migration risk:** invalidating cached escpos artifacts is a one-time re-render on next print; safe because artifacts are versioned.
- **Test order matters:** Phase 1's diagnostic header must ship first — every later phase leans on the log to prove it worked.

## Deliverables checklist

- [ ] `X-Renderer` header + structured log line on every escpos response
- [ ] Root cause of Espresso divergence identified from logs (Phase 1 output)
- [ ] Second ESC/POS producer eliminated (Phase 2)
- [ ] `escpos-single-owner.test.ts` architecture test
- [ ] `resolvePaperWidth` with fixed precedence + tests
- [ ] 40/58/80 mm golden `.escpos.bin` snapshots + width-invariant test
- [ ] `receipt_render_log` table + insert on every print
- [ ] Printer-profile UI shows last renderer + byte hash
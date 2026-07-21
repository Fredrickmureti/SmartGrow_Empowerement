
# Enterprise Printing Architecture — Continuation

## Current status (2026-07-21, end of turn)

**Active phase:** Phase 14 — Label template editor + printer self-service.

**Fully implemented and verified:**
- Phase 13 close-out: all 5 items landed (media-agnostic default tests, dispatcher error-taxonomy tests, housekeeping RAISE NOTICE migration, ADR-0087 addendum, D12 audit row). Printing suite 87/87 green.
- Phase 14 step 8 — `src/apps/platform/hardware/HardwareLabelTemplates.tsx` shipped at `/platform/hardware/labels`. Uses canonical `mediaGeometry.mmToCssPx` for the preview canvas (scales paper AND content together — fixes the reported defect where only the paper resized). Envelope-token detection (`^PW`/`^LL`/`q<dots>`/`Q<dots>,<gap>`) blocks Save when the operator pastes double-injection content. Media pin dropdown includes "Any (media-agnostic)". Nav + route wired.
- Phase 14 geometry consolidation — `src/services/printing/mediaGeometry.ts` is the single owner of mm→dot math. `ZplLabelDriver`, `EplLabelDriver`, `BrowserHardwareAdapter` and the preview canvas all delegate to it. Guardrail tests (`label-envelope-parity.test.ts`, `printer-profile-hardware-shape.test.ts`) updated to enforce this.
- Phase 13 canonical `resolve_label_template` republished with `DROP FUNCTION` (3-arg) + `REVOKE ALL FROM PUBLIC` + `GRANT EXECUTE` to `authenticated` and `service_role` so a fresh clone builds identically.
- Build: `bun run build:dev` green. Fixed JSX parse error in `HardwareLabelTemplates.tsx` `<DialogDescription>` (raw `<dots>`/`<gap>` in JSX text was parsed as an opening tag — wrapped copy in a `{"…"}` string literal).

**Pending (Phase 14 remaining):**
- Step 6 — "Bind to workflow" action on the printer detail sheet in `HardwareDevices.tsx`. Must insert into `printer_workflow_bindings` (workflow + branch + optional warehouse, 100-priority band) via canonical Records dialog primitives. RLS: admin/owner only.
- Step 7 — "Test print" button on the same sheet. Calls `printLabelByTemplate({ templateKey: 'product_label', vars: { name: 'Test', sku: 'TEST-000', barcode: '000000000000' }, workflow: 'product_tag', ... })` and surfaces structured result (template scope, printer scope, media geometry, driver bytes count) via toast + detail drawer.
- Step 9 — Follow-up tests:
  - `src/test/hardware/hardware-label-templates-editor.test.ts` — source-inspection that the editor imports `renderTemplateBody` from `labelDispatch` (no parallel token engine) and does not import `pdf-lib`/`bwip-js`/raw driver modules.
  - `src/test/printing/media-geometry-single-owner.test.ts` — `mediaGeometry.ts` is the sole exporter of `mediaDots` / `mmToCssPx`; drivers + preview import from it.

## Instructions for the next agent

1. **Verify before continuing.** Run `bun run build:dev` and `bunx vitest run src/test/printing/ src/test/hardware/` — both must be green. Then open `/platform/hardware/labels`, create a template pinned to a media profile, switch the media pin, and confirm the preview canvas rescales paper AND content together (this is the acceptance criterion for the reported defect). Inspect `src/services/printing/mediaGeometry.ts` and confirm both drivers (`ZplLabelDriver.ts`, `EplLabelDriver.ts`) plus `BrowserHardwareAdapter.ts` call `mediaDots(...)` rather than doing `dpi / 25.4` inline.
2. **Only then** pick up Phase 14 step 6 (Bind-to-workflow) → step 7 (Test print) → step 9 (guardrail tests). Do not skip ahead to Phase 15.
3. Use canonical Records dialog primitives for any new modal — no ad-hoc `<Dialog>` compositions outside the pattern already established in `HardwareLabelTemplates.tsx`.
4. When writing JSX text, remember: literal `<something>` in JSX text is parsed as a tag. Wrap technical strings that contain `<...>` in `{"…"}`.

## Verification of prior work (Phase 1)

I walked the codebase against `.lovable/plan.md`. Findings:


## Verification of prior work (Phase 1)

I walked the codebase against `.lovable/plan.md`. Findings:

**Landed and correct (Phases 7–12, and the migration+dispatcher parts of Phase 13):**
- `media_profiles` + hardware-shaped `printer_profiles` + `label_templates.media_profile_id` — migrations `20260721001823`, `20260721002219` present.
- ADR-0087 published; drivers (`ZplLabelDriver`, `EplLabelDriver`, `BrowserHardwareAdapter`) own the paper envelope.
- Admin surfaces `/platform/hardware/media` and `/platform/hardware/capability` shipped.
- Guardrail suite green: 11 test files in `src/test/printing/` covering envelope, resolver ordering, hardware shape, `NO_MEDIA_RESOLVED`, dispatch-requires-media, ZPL golden, kitchen ticket, print policies.
- **Phase 13 partial landing verified:** migration `20260721005711` correctly (a) nulls `media_profile_id` on `is_default=true, branch_id IS NULL` rows, (b) extends `resolve_label_template` with the `rnk=5` last-resort case, (c) rewrites `seed_default_label_templates()` to insert `media_profile_id = NULL`. Dispatcher (`src/services/printing/labelDispatch.ts`) does the head-count lookup and emits the sharpened error.

**Genuinely pending (contrary to the log's "active" framing — none of the 5 Phase-13 follow-ups are done):**
1. No test file `resolve-label-template-media-agnostic-default.test.ts`.
2. No test file `label-dispatch-error-taxonomy.test.ts`.
3. No housekeeping migration for non-default rows still pinning media.
4. ADR-0087 has no "defaults are media-agnostic" addendum.
5. Audit doc `2026-07-20-enterprise-output-platform.md` has no `D12` row (`grep -c D12` = 0).

Phase 14 is entirely unstarted (no `HardwareLabelTemplates.tsx`, no "Bind to workflow" flow on the printer-detail sheet, no test-print button).

No architectural drift found outside the plan's scope: the ownership matrix in ADR-0085 holds, ESLint rules (`no-raw-zpl-outside-printing`, `no-raw-escpos-bytes`, `no-raw-pdf-lib-in-app`, `no-direct-barcode-lib`) plus their runtime mirrors are enforcing chokepoints, and `Products.tsx`'s label seam matches the Wave B2.2 contract test.

## Plan

### Phase 13 close-out (do first, no Phase 14 work until every item is green)

1. **Regression test — media-agnostic default resolves.** New file `src/test/printing/resolve-label-template-media-agnostic-default.test.ts`. Two supabase-mocked cases against `resolve_label_template`:
   - Template with `media_profile_id = NULL`, caller passes no media → resolves (rank 4).
   - Template pinned to a media id, caller passes no media → still resolves via `rnk=5` last-resort.
   - Caller passes a matching media → rank 1 wins over the media-agnostic default.

2. **Regression test — dispatcher error taxonomy.** New file `src/test/printing/label-dispatch-error-taxonomy.test.ts`. Mocks `supabase.rpc('resolve_label_template')` + the head-count query:
   - Zero rows in `label_templates` → returns the plain `no label template registered` message.
   - Rows exist but resolver returns none → returns the sharpened "exists but could not be resolved for the requested scope" message that names branch/media and points at Platform → Hardware.
   - Resolver returns a ZPL row but no media resolves → `NO_MEDIA_RESOLVED` (guarded by existing `label-dispatch-requires-media.test.ts` — cross-reference, don't duplicate).

3. **Housekeeping data migration — audited, not blanket.** New migration that:
   - Runs a `SELECT id, org_id, template_key, name, created_at FROM label_templates WHERE is_default = false AND branch_id IS NULL AND media_profile_id IS NOT NULL` as a `RAISE NOTICE` for observability first.
   - Then nulls `media_profile_id` **only** on rows whose `created_at` falls inside the known seed migration timestamps (`20260721001823`, `20260721002219`, and any earlier seed introduced by Phase 9). Rows created by user CRUD are left alone — they may be intentional media variants.
   - Ships with a comment identifying the exact `WHERE created_at BETWEEN ... AND ...` window and cites ADR-0087.

4. **ADR-0087 addendum.** Add a "Defaults are media-agnostic" section: `is_default = true AND branch_id IS NULL` rows MUST have `media_profile_id = NULL`; only branch/media overrides may pin media; enforced by (a) the rewritten seed function, (b) the resolver's `rnk=5` safety net, (c) the housekeeping migration above.

5. **Audit doc D12 row.** Append a D12 row to `docs/audit/2026-07-20-enterprise-output-platform.md` describing the "seeded default pinned to a media profile → silent drop at dispatch → 'no template registered'" defect, the three-part fix (seed function, resolver rnk=5, dispatcher error sharpening), and marking it closed 2026-07-21 with the tests from steps 1–2 as guardrails.

### Phase 14 — Label template editor + printer self-service

Prerequisite: every Phase-13 item above closed and `bunx vitest run src/test/printing/` green.

6. **Bind-to-workflow flow on the printer detail sheet.** In `HardwareDevices.tsx` (printer detail), add an inline "Bind to workflow" action that creates a `printer_workflow_bindings` row for the selected workflow + branch + optional warehouse. Uses the canonical Records dialog primitives, respects RLS. This is the missing-CTA failure mode from the Phase 13 root cause: an org with a device but no binding.

7. **Test-print action.** On the same sheet, a "Test print" button that dispatches `printLabelByTemplate({ templateKey: 'product_label', vars: { name: 'Test', sku: 'TEST-000', barcode: '000000000000' }, workflow: 'product_tag', ... })` and surfaces the structured result (template scope, printer scope, media geometry, driver bytes count). Proves the full chain end-to-end on first-run.

8. **`HardwareLabelTemplates.tsx` at `/platform/hardware/labels`.** CRUD over `label_templates` (org + branch scope switcher), engine picker (`zpl`/`epl`/`escpos`/`pdf`), media-profile picker, body editor. Live canvas renders the body at the picked printer's DPI so operators see actual output size — canvas uses the same physical-mm → dot math the drivers use (extract into `src/services/printing/mediaGeometry.ts` and reuse in both the drivers and the preview so there is one owner of scaling math).
   - Preview MUST call the same substitution helper (`renderTemplateBody`) already exported from `labelDispatch.ts` — no parallel token engine.
   - "Test print" button reuses (7).
   - Nav entry added under Platform → Hardware.

9. **Follow-up tests.**
   - `src/test/hardware/hardware-label-templates-editor.test.ts`: source-inspection that the editor imports `renderTemplateBody` from `labelDispatch`, does not build its own tokens, and does not import `pdf-lib`/`bwip-js`/raw driver modules.
   - `src/test/printing/media-geometry-single-owner.test.ts`: extracted `mediaGeometry.ts` is the only source of the mm→dot conversion and the drivers + preview both import from it.

### Explicit non-goals (unchanged)

- No change to A4/PDF or POS receipt pipelines.
- No emulator/margin/font tweaks.
- No change to `HardwareClient`, transport, or agent wire protocol.
- Legacy `printer_profiles.paper_format` migration stays a separate follow-up (already logged in the audit doc).

## Technical notes

- `resolve_label_template` is a 4-arg RPC; keep the signature stable. The `rnk=5` case is the resolver's forward-compatibility guarantee — do not delete it as part of the housekeeping migration.
- The housekeeping migration must run inside a transaction and log affected `id`s via `RAISE NOTICE` before the `UPDATE` so the operation is auditable.
- Media geometry helper (Phase 14 step 8) must live in `src/services/printing/` (client-safe, no server-only imports) and be pure so both the drivers (Node/Electron + browser adapter) and the React preview canvas can import it. This is the "renderer exists only once" principle from ADR-0085 applied one level down at the scaling-math layer.
- Every new admin surface uses the canonical Records dialog primitives — no ad-hoc modals (design-system audit already enforces this).
- Success criterion for Phase 14: an operator on a fresh org can, without SQL, (a) create a printer profile with media, (b) bind it to `product_tag`, (c) edit a label template with a live-sized preview, (d) click Test print, and see the exact bytes hit `hardware_exec_log` with `NO_MEDIA_RESOLVED` never appearing when the config is valid.

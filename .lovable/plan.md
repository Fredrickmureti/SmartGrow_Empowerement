# Enterprise Printing Architecture — Continuation Plan

## Current status

**Active phase:** Phase 13 — production hardening & data hygiene (in progress).
**Next phase:** Phase 14 — label template editor with live media-aware preview + printer/binding self-service.

---

## Phases 7–12 — LANDED & VERIFIED

- **Phase 7–9 (schema & media layer):** `media_profiles` table (+ RLS, grants, per-org auto-seed trigger); `printer_profiles` extended with `command_language / dpi / margins_mm / supported_media_ids[] / capabilities[]`; `label_templates.media_profile_id` FK + composite unique index; `resolve_label_template` rewritten to 4-arg with media fallback.
- **Phase 10 (drivers own envelope):** `ZplLabelDriver`, `EplLabelDriver`, `BrowserHardwareAdapter` all inject `^PW/^LL` (ZPL) or `q/Q` (EPL) from resolved media + DPI. Template bodies are envelope-free (ADR-0087 contract).
- **Phase 11 (admin surfaces):** `HardwareMedia.tsx` (`/platform/hardware/media`) and `HardwareCapability.tsx` (`/platform/hardware/capability`) shipped; nav entries added; both use canonical Records dialog primitives.
- **Phase 12 (guardrails, ADR, audit closure):** ADR `docs/adr/0087-media-and-printer-capability.md` published; audit `docs/audit/2026-07-20-enterprise-output-platform.md` updated with D7–D11 closure. Guardrail tests green (11 files, 73 tests): envelope-free bodies, media required on ZPL/EPL dispatch, printer-profile hardware shape, envelope parity across transports, resolver ordering, `NO_MEDIA_RESOLVED` structured error.

---

## Phase 13 — Production hardening & data hygiene (ACTIVE)

Triggered by a real-world failure: `Products → Print label` toasted **"No label template registered for key 'product_label'"** for an org that in fact had the template. Root cause: the Phase-9/10 seed inserted default rows with a **pinned** `media_profile_id`. When callers had no `printer_workflow_bindings` yet, `p_media_profile_id` arrived NULL and every row scored `rnk=99` in the resolver, so 0 rows returned — indistinguishable from "no template" at the dispatch layer.

**Landed in this wave**

- Migration `2026-07-21_fix_label_template_default_media_agnostic.sql`:
  - Nulls `media_profile_id` on all `is_default = true, branch_id IS NULL` rows so the resolver's media-agnostic ranks (2, 4) match them.
  - Adds `rnk=5` last-resort case to `resolve_label_template` — template pins media but caller has none → still resolves. Prevents this class of silent-drop regression forever.
  - Rewrites `seed_default_label_templates()` to insert `media_profile_id = NULL` for new orgs and inlines the canonical envelope-free ZPL body. Future orgs are correct by construction.
- `src/services/printing/labelDispatch.ts`: dispatcher now distinguishes "no template row at all" from "rows exist but ranking dropped them" and returns an actionable message that names the branch/media scope and points operators to Platform → Hardware.

**Pending in Phase 13 (do next, in order)**

1. Add regression test `src/test/printing/resolve-label-template-media-agnostic-default.test.ts`: seed one `product_label` template with `media_profile_id = NULL`, call the RPC with no media, assert it resolves. Also asserts `rnk=5` last-resort case with a pinned template.
2. Add `src/test/printing/label-dispatch-error-taxonomy.test.ts`: mock supabase to assert the dispatcher emits the sharpened error when template rows exist but resolver returns none, and the original error only when 0 rows exist.
3. One-time housekeeping migration to null-out any org-scope non-default rows that were seeded with a media pin they shouldn't have (audit `label_templates` for `is_default = false AND branch_id IS NULL AND media_profile_id IS NOT NULL` before altering — some may be intentional branch/media variants; only touch rows created by known seed timestamps).
4. Update `docs/adr/0087-media-and-printer-capability.md` with an addendum: "Default templates are media-agnostic. Only branch/media overrides may pin a `media_profile_id`."
5. Update `docs/audit/2026-07-20-enterprise-output-platform.md` D-column with a new row D12 (this defect) marked closed.

---

## Phase 14 — Label template editor + printer self-service (NEXT)

Prereq: Phase 13 fully closed and green.

- `src/apps/platform/hardware/HardwareLabelTemplates.tsx` — CRUD over `label_templates`, with a media-picker + live canvas that renders the body at the picked printer's DPI so operators see actual output size.
- `HardwareDevices.tsx` printer-detail sheet: add a one-click "Bind to workflow" flow that creates a `printer_workflow_bindings` row. This eliminates the class of failure that produced the current bug (org exists, printer configured, but no workflow binding → no media → dispatch fails).
- Extend the label editor with a "Test print" button that dispatches through `printLabelByTemplate` against sample data. First-run experience proves the whole chain end-to-end.

---

## Explicit non-goals (unchanged)

- No change to A4/PDF or POS receipt pipelines.
- No emulator/margin/font tweaks.
- No change to `HardwareClient`, transport, or agent wire protocol.

---

## Instructions for the next agent

**Before writing new code**, verify Phase 13 landed correctly:

1. Query: `SELECT count(*) FROM label_templates WHERE is_default = true AND branch_id IS NULL AND media_profile_id IS NOT NULL` — must be `0`.
2. Read `resolve_label_template` via `pg_get_functiondef` — must contain the `rnk = 5` case with the comment "last-resort".
3. Read `seed_default_label_templates` — must set `media_profile_id = NULL` on the `INSERT`.
4. Read `src/services/printing/labelDispatch.ts` around the `if (!tpl)` block — must do the `count`-head lookup and emit the sharpened error.
5. Run the label-printing test suite: `bunx vitest run src/test/printing/` — must be green.

Once verified, resume at **Phase 13 pending item #1** (regression test for media-agnostic default resolution). Do not skip to Phase 14 until every Phase-13 pending item is closed and the audit row D12 is written.

Maintain chronological execution. Do not open unrelated work while any Phase-13 item is open.
============================================================================================


All 73 printing tests green across 11 files. Chronological wrap-up:

Phase V.1 — media-profile-resolution.test.ts locks the 4-tier fallback ordering in resolve_label_template.
Phase V.4 — labelDispatch.ts now returns a structured NO_MEDIA_RESOLVED error for ZPL/EPL when no media resolves; label-dispatch-requires-media.test.ts guards it.
Phase 11 — new /platform/hardware/capability admin surface for printer_profiles (command language, DPI, margins, supported media multiselect), wired into nav + routes.
Audit — D7–D11 rows updated with the new surface + all six guardrail tests; the label template body editor stays flagged as deferred follow-up.

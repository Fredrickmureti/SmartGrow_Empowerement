# Certificate Publishing — Phase 1 Verification Audit

**Date:** 2026-07-13
**Auditor:** Incoming engineering lead (post-handoff)
**Scope:** Verify the previous agent's end-of-turn claims before
building on top of them. Read-only; no code changes in this pass.

---

## Method

For each claim: locate the code, run the guarding test, record
file:line evidence. Verdicts:

- **Verified** — claim matches code and tests exercise the behaviour.
- **Partial** — code is present but the claim overstates it.
- **Not landed** — no evidence in tree.
- **Regressed** — the claim was true and is now broken.

---

## Claim 1 — v4 engine primitives compile in both mirrors

**Verdict: Verified (with a small mirror-drift caveat).**

- `grid`, `list`, `label_fill`, `field_row`, `columns`, `page_break`
  all dispatch in the browser compiler
  (`src/features/localization/lib/engine/compile.ts:304-309`) and in
  the Deno mirror
  (`supabase/functions/_shared/certificate-engine/compile.ts` — same
  case block, offset by the `// @ts-nocheck` preamble).
- `certificate-engine.compile.test.ts` (11 tests) passes and covers
  grid header stack, `sum_of` footers, list nesting, `label_fill`,
  `field_row`, `columns`, and `page_break`.

**Caveat — mirror is NOT byte-identical.** Memory doc
(`mem/features/certificate-rendering.md`) says the two files are
"byte-identical apart from the preamble and `.ts` import suffixes".
Actual diff shows extra divergence around the `sum_of` footer cell
(lines 481-490 in the browser file): the browser side lifts
`cell.content` into a `const content` before narrowing; the Deno side
narrows directly on `cell.content`. Behaviour identical, but the
mirror-parity test (if we add one) must tolerate this or the drift
will grow. **Action:** align both files verbatim during Phase 2.4.

## Claim 2 — Country-agnostic invariant enforced

**Verdict: Verified.**

- `src/test/localization/certificate-editor.country-agnostic.test.ts`
  passes (5 tests). It scans `compile.ts` (both mirrors), `types.ts`,
  `CertificateV3Editor.tsx`, `GridDesigner.tsx`, and
  `templates/genericExample.ts` for the forbidden token list
  (`paye, nhif, shif, nssf, ahl, nita, kra, p9, irp5, w-2, w2, p60,
  sdl, kenya, ghana, uganda`, …).
- Removing a token check locally would fail the test — the ruleset is
  substantive, not decorative.

**Action:** extend the scan list to any new Designer files created in
Phase 2.

## Claim 3 — `data-ce-node` click-to-select bridge

**Verdict: Verified in code; NOT verified end-to-end.**

- Emission: `compile.ts:64-71` wraps every top-level document/header/
  footer node with `data-ce-node="<scope>.<i>"` and `data-ce-type`.
- Preview surface: `CertificateHtmlSurface.tsx:37-95` injects a bridge
  script that listens for clicks on `[data-ce-node]` and posts them up
  via `window.parent.postMessage`; also listens for
  `certificate-engine:select` to apply the `.ce-selected` outline.
- Editor consumer: `CertificateTemplateEditor.tsx:167-174` receives
  the id via `onSelectNode` and scrolls `[data-ce-editor-node="<id>"]`
  into view.

**Gap:** no Playwright smoke and no unit test asserts that a click in
the iframe actually reaches the editor and scrolls the correct card.
The wiring is plausibly correct but has never been proven under a
running browser. **Action:** add Playwright smoke in Phase 2.4.

## Claim 4 — Validator rewritten (v4-only bodies validate)

**Verdict: Verified.**

- `validateV3Body` in `CertificateV3Editor.tsx` is role-based (checks
  primitive kinds, not specific field names).
- Test `certificate-editor.country-agnostic.test.ts` includes a
  "v4-only body validates" case.
- `validate-localization-payload` edge function still validates
  templates against `pack_token_registry` and returns unknown-token
  errors as before.

## Claim 5 — KE P9 template matches KRA original structurally

**Verdict: Partial. Requires a structured-diff pass.**

- Template file: `src/features/localization/lib/engine/templates/keP9.ts`
  (414 lines) exports `KE_P9_V3_TEMPLATE`.
- Compile-test coverage exists (`ke-p9-v10.compile.test.ts`) but is
  **shape-level**, not visual: it asserts the template compiles and
  emits `data-ce-node` markers. It does NOT diff against the
  authoritative KRA layout.
- Structural comparison against the reference PDF (from user
  attachments) was NOT performed by this audit — the reference PDF
  needs to be parsed and reduced to a structural spec (columns,
  header rows, letter row, unit row, sub-instruction row, IMPORTANT
  block, Attach block, paper orientation) before we can claim parity.

**Action:** Phase 2.3 opens with a structural diff of `keP9.ts`
against the government form and records deltas in this audit doc as
an amendment.

## Claim 6 — Editor promoted to full-viewport 3-pane layout

**Verdict: Partial / overstated.**

- `CertificateTemplateEditor.tsx:176-291` renders a **2-pane**
  layout (Canvas · Inspector) via `ResizablePanelGroup`, with a
  bottom action bar. It is NOT 3 panes — there is no dedicated
  Outline pane and no top toolbar ribbon.
- It is still mounted inside a `WorkflowSheet` drawer
  (`PackEntityTabs.tsx:585-676`, `size="full"`) rather than a
  dedicated route. The Sheet at `size="full"` is close to
  full-viewport, but it is still a modal Sheet component, not a page.
- The user's explicit complaint ("dedicated page… not right sheets")
  is therefore NOT yet resolved.

**Action:** Phase 2.1 (dedicated route) + Phase 2.2 (3-pane +
toolbar) are the primary Phase-2 deliverables. Everything else in the
current editor (metadata card, outputs card, `CertificateV3Editor`,
`TemplateFieldInspector`, action bar) is retained; only the shell
around them changes.

## Claim 7 — Test suite passing

**Verdict: Verified for the certificate/localization slice.**

- `bunx vitest run certificate-engine.compile certificate-editor.country-agnostic`
  → 16/16 pass locally.
- The previous agent's "127 tests passing" number was not reproduced
  end-to-end in this audit; the localization slice is green, and
  unrelated pre-existing failures (attendance/inventory/finance/HR
  architecture tests) are outside this track's scope.

---

## Summary

| Claim | Verdict |
|---|---|
| 1. v4 primitives in both mirrors | Verified (mirror drift note) |
| 2. Country-agnostic invariant | Verified |
| 3. `data-ce-node` bridge | Verified in code; E2E unproven |
| 4. Validator v4-aware | Verified |
| 5. KE P9 matches KRA layout | Partial (needs structural diff) |
| 6. Full-viewport 3-pane editor | Partial / overstated |
| 7. Localization tests pass | Verified |

**Two claims materially overstate reality: #5 (structural parity with
the government form) and #6 (dedicated full page + 3-pane).** These
are the exact two things the user called out. Phase 2 targets both
head-on. No regression discovered — building on top of the current
state is safe, we simply need to finish the job.

## Follow-ups tracked into Phase 2

- [ ] 2.1 — Dedicated route for certificate edit (`/localization/packs/$packId/certificates/$templateId/edit`).
- [ ] 2.2 — Add Outline pane + top toolbar ribbon to the editor; keep existing Canvas + Inspector.
- [ ] 2.3 — Structural diff of KE P9 against the KRA PDF; recorded as amendment to this doc.
- [ ] 2.4 — Playwright smoke for the `data-ce-node` click bridge; align the two `compile.ts` mirrors verbatim; extend country-agnostic scan to new Designer files.
- [ ] Deferred — dedicated routes for other localization entities (rules, returns, tokens, authorities, garnishments, bank exports, requirements, governance). Sheet-based edits remain for them until this track lands and the pattern is proven on certificates.


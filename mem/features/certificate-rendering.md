---
name: Certificate rendering architecture
description: Statutory certificate rendering — country-agnostic AST (v3 legacy + v4 enlarged) + HTML/CSS engine with pack-owned Theme. Never reintroduce pdf-lib hand-drawing.
type: constraint
---
# Certificate / statutory document rendering

**Single path only.** Statutory certificates (KRA P9, W-2, P60, …) render
through ONE pipeline:

1. Country-agnostic AST on `template.body`:
   - `schema_version: 3` — legacy primitives: matrix, identity_strip, key_value,
     rich_text, legal_notice, signature_strip, section, spacer, image, heading.
   - `schema_version: 4` — enlarged primitives for statutory-form parity:
     **grid** (cell-level colspan/rowspan header stack + footer_rows with
     sum_of), **list** (nested, marker-configurable: decimal / lower-alpha /
     lower-alpha-paren / lower-roman-paren / …), **label_fill** (inline
     "Label ......... value" with dotted/solid rule), **field_row** (inline
     label-fill group), **columns** (multi-column region for e.g. IMPORTANT +
     Attach), **page_break**.
   - Both coexist in a single document. Prefer v4 for new templates.
2. `compile()` (`src/features/localization/lib/engine/compile.ts`) → HTML + CSS
   Paged Media. Deno mirror at
   `supabase/functions/_shared/certificate-engine/compile.ts` — keep in sync
   (byte-identical apart from the `// @ts-nocheck` preamble and `.ts` import
   suffixes).
3. Rendered client-side with **paged.js** in an isolated iframe
   (`CertificateHtmlSurface.tsx`). Preview == filed PDF by construction.

**Theme is pack-owned.** All presentation tokens live on `template.theme`
(`Theme` in `types.ts`) — body/heading font, base font size, rule color +
weight, header shade / letter shade / unit shade, zebra on/off, heading case,
numeric letter spacing, legal-border. Engine CSS uses `var(--ce-*)`
substitution; `ENGINE_DEFAULT_THEME` preserves the pre-v4 aesthetic for legacy
templates. **Never** hardcode aesthetics in the compiler — the
`certificate-engine.compile.test.ts` "emits theme CSS custom properties" test
guards this.

**Country-agnostic invariant.** The engine (types.ts + compile.ts) contains
NO country/statute/regulator tokens. Enforced by the "no country tokens" test
which scans both files. Forbidden list: paye, nhif, shif, nssf, ahl, nita,
kra, p9, irp5, w-2, w2, p60, sdl. All jurisdiction knowledge lives in
pack-authored templates (`keP9.ts`, future `ghGRA.ts`, `usW2.ts`, …).

**Forbidden (do NOT rebuild):** rendering certificates with pdf-lib hand-drawn
cells (`drawCell`/truncation). The old v1 `certificateRenderer.ts`, v2
`certificateRendererV2.ts`, and `astPdfProducer.ts` are the *bad design* that
produced crushed/overflowing P9s. pdf-lib is a low-level drawing lib — the
wrong tool for a statutory grid.

**Editor:** `CertificateV3Editor.tsx` (structured — no raw-JSON textareas).
Per-node inspectors ship for all v3 and v4 primitives — `grid` (columns +
header/footer row stacks with span/rowspan/variant + `sum_of` footer cells),
`list` (nested, marker-configurable), `label_fill`, `field_row`, `columns`
(per-column child editors), and `page_break`. A full Excel-like spreadsheet
designer with drag-resize and live per-node preview is still Phase C's
end-goal; this editor is the typed intermediate that unblocks pack authoring
of v4 templates.

**Canonical KE P9 body:** `src/features/localization/lib/engine/templates/keP9.ts`.
On v4 as of the 2026-07-13 architecture audit. Produces a 4-row header stack
(label · unit `Kshs.` · letter A–O · sub-instruction for E1/E2/E3), inline
label_fill identity, two-column IMPORTANT + Attach block, statutory-form
theme (Times body, black rules, no zebra, no grey shading).

**Statutory paper:** `assertStatutoryPaper` allows A3, A4, Letter, Legal —
each in portrait and landscape (`STATUTORY_PAPER_ALLOWLIST`). Which paper is
legal for a filing is pack metadata, not shared-helper code. The KRA P9 is
legally A4 **landscape** — never force it portrait.

**Server-side PDF:** NOT yet implemented (Phase D). Today's "PDF" only exists
if a user hits Print in the browser preview. The audit-plan Phase D adds a
swappable `PdfProducer` interface with a Cloudflare Browser Rendering
adapter (native Workers binding, same Chromium as preview, no external
secret) so email dispatch / e-filing / bulk export produce real
`application/pdf` bytes. Currently `generate-tax-certificate` stores the
compiled HTML as `text/plain` to bypass the bucket MIME whitelist — a
workaround to be replaced when Phase D lands.

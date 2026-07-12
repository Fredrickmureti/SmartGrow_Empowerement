---
name: Certificate rendering architecture
description: Statutory certificate/P9 rendering — single country-agnostic v3 AST + HTML/CSS engine rendered client-side with paged.js. Never reintroduce pdf-lib hand-drawing.
type: constraint
---
# Certificate / statutory document rendering

**Single path only.** Statutory certificates (KRA P9, etc.) render through ONE
pipeline:

1. Country-agnostic v3 AST on `template.body` (`schema_version: 3`) —
   `src/features/localization/lib/engine/types.ts`. The engine NEVER encodes a
   country, statute, or form name; all layout + strings are pack-authored.
2. `compile()` (`src/features/localization/lib/engine/compile.ts`) → HTML + CSS
   Paged Media. Deno mirror at
   `supabase/functions/_shared/certificate-engine/compile.ts` — keep in sync.
3. Rendered client-side with **paged.js** in an isolated iframe
   (`CertificateHtmlSurface.tsx`). Preview == filed PDF by construction.

**Forbidden (do NOT rebuild):** rendering certificates with pdf-lib hand-drawn
cells (`drawCell`/truncation). The old v1 `certificateRenderer.ts`, v2
`certificateRendererV2.ts`, and `astPdfProducer.ts` are the *bad design* that
produced crushed/overflowing P9s. **Why:** multiple past agents thrashed the
KRA P9 between v1/v2/v3 pdf-lib renderers (~8 migrations in one day) and burned
hundreds of credits without fixing the layout. pdf-lib is a low-level drawing
lib — the wrong tool for a statutory grid.

**Editor:** structured WYSIWYG only (`CertificateV3Editor.tsx`) — no raw-JSON
textareas, no legacy section palette, no v2 blocks. Matrix columns support
`header` + `sub_header` (e.g. A..O letters) + `unit` (e.g. "Kshs.") rendered as
stacked header rows, plus `column_groups`.

**Canonical KE P9 body:** `src/features/localization/lib/engine/templates/keP9.ts`.

**Statutory paper:** `assertStatutoryPaper` allows `a4` and `a4-landscape`.
The KRA P9 is legally A4 **landscape** — never force it portrait.

## Audit summary — what the previous agent actually shipped

I traced Publisher → template body → renderer → PDF and compared it against the two attached PDFs. Here is the verified state, not the claimed state.

**Architecturally sound (keep):**
- `src/features/localization/lib/engine/{types,compile,resolver}.ts` + its Deno mirror in `supabase/functions/_shared/certificate-engine/` — a genuine country-agnostic AST (paper format, page master, matrix with column groups / sub-headers / units / derived columns, identity strip, legal notice, signature strip). The engine file has zero references to Kenya, KRA, P9, PAYE, SHIF, etc. This is the correct Odoo-style separation.
- `compile()` → HTML + CSS Paged Media, rendered by paged.js inside an isolated iframe in both `CertificateHtmlSurface.tsx` (editor preview) and `printCertificateHtml.ts` (tenant download). Preview == filed document by construction. This is the right pipeline.
- `KE_P9_V3_TEMPLATE` in `engine/templates/keP9.ts` — country knowledge lives entirely here, referenced by the DB seed and the editor "Seed from Kenya P9" action.
- DB migration `20260712172321…` registers the v3 JSON schema and the validator recognises `schema_version=3` bodies. The `P9` row in `localization_pack_certificate_templates` is on v3.

**Broken / incomplete (this is why `Our_System_Generated.pdf` looks like a report, not a form):**

1. **The rollout is 1 of 5 templates.** DB inspection:

   ```text
   P9                            → schema_version 3   (v3 engine)   ✅
   P9A                           → schema_version 2   (pdf-lib v2)  ❌  ← the user's PDF
   CERT_OF_SERVICE               → schema_version 2   (pdf-lib v2)  ❌
   GH_PAYE_EMPLOYEE_ANNUAL       → no schema_version  (pdf-lib v1)  ❌
   ANNUAL_EARNINGS_STATEMENT     → no schema_version  (pdf-lib v1)  ❌
   ```

   The attached "Our System Generated" is `P9A`, which never went through the new engine — it is drawn by `certificateRendererV2.ts` (pdf-lib, 1025 lines). The overlapping headers ("MONT/H", "NON-CAS/H BENEFIT", "PENSION/NSSF" colliding with "DEDUCTIBLE CAP"), cramped columns, no KRA masthead, no `APPENDIX 2A`, no legal notice — these are the exact `drawCell`/truncation failures the `mem://features/certificate-rendering` memory file forbids re-introducing.

2. **The forbidden legacy renderers are still live.** `certificateRenderer.ts` (v1, 714 lines), `certificateRendererV2.ts` (v2, 1025 lines), and their Deno twins are the fallback for any template with `schema_version < 3`. `generate-tax-certificate/index.ts:777` still calls `renderCertificatePdf(...)` for the whole non-v3 population. As long as they exist they will be re-used and re-fixed.

3. **No headless HTML→PDF producer is wired.** `certificate-engine/engine.ts` defines a `PdfProducer` interface but ships `UnwiredPdfProducer` that throws. For v3, the server stores compiled HTML and the *browser* rasterises via paged.js. This is fine for a signed-in user clicking Download, but breaks: email attachments, `generate-statutory-return` bundles, scheduled filings, KRA portal uploads that require a real PDF. Statutory paper is A4-pinned but the produced bytes are `text/html`.

4. **Editor is functional but not enterprise-grade.** `CertificateV3Editor.tsx` (556 lines) exposes only the 9 primitives with basic scalar controls. No visual node reordering surface beyond up/down buttons, no column-group inspector wired to the matrix, no page-master WYSIWYG, no token picker on ValueEditor (paths are typed free-hand into an Input), no rich-text run editor beyond a plain textarea, no unresolved-binding jump-to-node. Publishers can technically author a v3 body, but only if they already know the payload shape.

5. **XLSX renderer is a parallel stack.** `certificateXlsxRenderer.ts` reads v2 `sections/blocks` directly. When a v3 template declares `xlsx` output the code path silently falls back to nothing usable.

## Decision

Do NOT redesign the v3 engine — it is correct. The failure mode is that the previous agent stopped after one template and left every other certificate on the "bad design" pdf-lib path. Finish the rollout, then delete the legacy stack so it cannot regress, then close the two real architectural gaps (headless producer, editor ergonomics).

## Plan

### Step 1 — Migrate every remaining certificate template to v3

Data migration only (no engine change). For each pack row currently on `sections`/`blocks`:

- Rewrite the body as a `schema_version: 3` AST following the KE P9 template pattern: `paper_format` (statutory A4 / A4-landscape), `page_master` (masthead + running footer), `document` (identity_strip, matrix with `column_groups` + `sub_header` + `unit` + `derived_columns`, `legal_notice`, `signature_strip`).
- Templates to migrate: **P9A** (Kenya low-income, KRA masthead + Appendix 2A + full column A–O grid matching `Original-p9-Template.pdf`), **CERT_OF_SERVICE**, **GH_PAYE_EMPLOYEE_ANNUAL** (Ghana), **ANNUAL_EARNINGS_STATEMENT**.
- Verify each migrated template renders through `CertificateHtmlSurface` against its country's fixture with zero unresolved bindings.
- Add a `pack_audit_log` row per migration; keep the previous v2 body in the audit payload so publishers can compare.

Success gate: `select count(*) from localization_pack_certificate_templates where (body->>'schema_version')::int < 3` returns 0.

### Step 2 — Retire the pdf-lib renderers (irreversible)

Once step 1 is verified:

- Delete `src/features/localization/lib/pdf/{certificateRenderer.ts, certificateRendererV2.ts, certificateRenderer.dispatch.ts, winansi.ts}` and their Deno twins under `supabase/functions/_shared/pdf/`.
- Delete `certificateXlsxRenderer.ts`'s v2/sections branches; rewrite it as a thin v3 consumer that walks the AST (identity_strip → header rows, matrix → sheet with column groups, totals → footer band). Same input (`CertificateTemplateV3`, resolved payload) as `compile()`.
- Remove `renderCertificatePdf` from `generate-tax-certificate/index.ts` and the `isV3EngineTemplate` fork — v3 becomes the single path.
- Tighten the DB trigger `assert_certificate_template_body_valid` to reject any new insert/update with `schema_version < 3`. Add an architecture guard test that fails if the pdf-lib files reappear (mirror of the "no country-named functions" test).

### Step 3 — Ship a headless HTML→PDF producer

`generate-tax-certificate` and `generate-statutory-return` must be able to emit real `application/pdf` bytes without a browser. Wire a `PdfProducer` implementation:

- Preferred: call a small, dedicated Deno-friendly service (Chromium headless in a Cloudflare Browser / Playwright container, or a Puppeteer worker) — the compiled HTML is self-contained so any headless-chrome endpoint works. Configure via a `PDF_RENDERER_URL` secret so the platform is portable.
- Producer contract stays `produce(html) → Uint8Array`; the AST/compile layer does not learn about the runtime.
- Storage: keep both artifacts — `certificate.html` (audited source) and `certificate.pdf` (rasterised twin). Downloads default to PDF; the HTML remains the canonical audit artifact so preview == filed still holds bit-for-bit.
- `assertStatutoryPaper` continues to run — the producer never chooses paper.

### Step 4 — Upgrade the publisher editor for enterprise authoring

Keep the `CertificateV3Editor` shape, replace weak controls:

- Token picker on every `ValueEditor` — reads `pack_token_registry` for the certificate's country/pack and offers dotted paths with type hints instead of free-text.
- Matrix inspector: dedicated panel for columns (add / delete / drag-reorder), column groups (label + span, auto-validated against column count), derived columns (`sum/sub/min/max/pct` DSL with an argument autocomplete drawn from other matrix keys), footer sum picker.
- Page-master editor: separate header/footer canvas with the same node palette as the body.
- Live diagnostics panel: unresolved bindings, schema violations, and derived-column arg errors, each with "jump to node".
- Structural node reorder via drag-and-drop (dnd-kit, already in the app).
- Delete the last remaining legacy palette entry points in `BlocksEditor.tsx` and `TemplateEditor.tsx` so publishers cannot open a v2 authoring surface.

### Step 5 — Regression + verification

- Golden fixture test per country: compile each migrated template against its fixture, snapshot the HTML, snapshot the PDF page count + text layer, fail on any diff.
- Visual QA: render `P9A`, `CERT_OF_SERVICE`, and both v3 templates side-by-side with the official reference PDFs; iterate on paper-format margins and column widths in the *pack body only* (no engine changes) until each looks like a professionally published form. Attach before/after screenshots to the pack_audit_log entries.
- Architecture guards:
  - Existing test in `mem://features/certificate-rendering` scope: pdf-lib forbidden — extend to fail if any file under `src/features/localization/lib/pdf/` or `supabase/functions/_shared/pdf/` re-appears.
  - New test: every row in `localization_pack_certificate_templates` must be `schema_version >= 3`.

## Technical details

### File map

- **Keep, no change:** `engine/{types,compile,resolver}.ts` (and Deno twins), `CertificateHtmlSurface.tsx`, `CertificatePreviewPane.tsx`, `printCertificateHtml.ts`, `_monthlyMatrix.ts`.
- **Rewrite:** `certificateXlsxRenderer.ts` (v3-only), `generate-tax-certificate/index.ts` (drop the fork), `CertificateV3Editor.tsx` (richer controls), `certificate-engine/engine.ts` (real producer).
- **Delete:** `certificateRenderer.ts`, `certificateRendererV2.ts`, `certificateRenderer.dispatch.ts`, `winansi.ts`, `_shared/pdf/certificateRenderer*.ts`, associated parity tests.
- **New:** `certificate-engine/pdfProducer.ts` (headless HTTP producer), `supabase/functions/_shared/pdf-renderer-client.ts`, migration files for each template rewrite, one migration tightening the validator.

### Data-flow after this plan

```text
Publisher edits v3 AST (CertificateV3Editor)
        │
        ▼
localization_pack_certificate_templates.body  (schema_version = 3, validated)
        │
        ▼
generate-tax-certificate
        │  compile(template, payload)  ← engine.ts, country-agnostic
        ▼
        HTML + CSS Paged Media          (stored as .html, audit artifact)
        │
        ├── PdfProducer.produce(html) → PDF bytes  (stored as .pdf, filed)
        └── XlsxRenderer.produce(ast)  → XLSX      (Odoo-style editable twin)

Editor preview and tenant download both re-render the same HTML through paged.js
→ preview === filed PDF, bit-for-bit.
```

### Non-goals

- No pixel-perfect reproduction of the KRA template — the plan targets *information architecture parity* (masthead, Appendix marker, grouped columns A–O, legal notice, signature strip) authored inside the pack, not hard-coded margins.
- No engine-side country code, ever. Any country-shaped test that leaks into `engine/` fails the architecture guard.
- Backwards compatibility with `schema_version < 3` is intentionally dropped — the codebase has no production tenants on those templates, and preserving them re-introduces the pdf-lib stack we are deleting.

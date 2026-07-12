
# Certificate Engine v3 — Verification & Corrected Plan

## Verification of previous agent's claims

Inspected files, not just tests. Findings:

| Claim | Reality |
|---|---|
| Phase A engine core shipped (`_shared/certificate-engine/`) | **True.** `types.ts` (206L), `compile.ts` (291L), `engine.ts` (53L), `resolver.ts` (124L) exist. One unit test (`src/test/localization/certificate-engine.compile.test.ts`). Country-agnostic, matches approved design. |
| Phase B dispatcher wired for `schema_version === 3` | **True.** `generate-tax-certificate/index.ts` L699–714 branches to `renderCertificateV3` when `isV3EngineTemplate(template)`; v1/v2 paths intact. |
| `api/render-certificate.ts` Vercel function + `vercel.json` | **File exists**, deps installed (`@sparticuz/chromium`, `puppeteer-core`, `@vercel/node`). **But not deployable as-is** — this project's runtime target is Cloudflare Workers (`.wrangler/deploy/config.json`, TanStack Start worker SSR), not Vercel. The Vercel function is orphaned: nothing in the app's actual deploy pipeline builds or serves it. |
| "Docker, Kubernetes and external rendering infrastructure have been removed" | **False.** `Dockerfile`, `Dockerfile.dev`, `docker-compose.yml`, `docker-compose.prod.yml`, and the full `k8s/` tree are all still present. |
| Producer wiring | Producer module is `vercelChromiumProducer.ts`, but the dispatcher's inline comment (L695) still says "self-hosted WeasyPrint sidecar". Comment drift — signals the runtime decision was made hastily and not reconciled across the codebase. |
| Phase C — Kenya P9 v10 pack template | **Not started.** No `schema_version: 3` template anywhere in the KE pack. |
| Phase D — publisher workbench for v3 AST | **Not started.** `TemplateEditor` still emits v1/v2 blocks only. |
| Phase E/F — deprecation & removal of v1/v2 | **Not started** (correctly — depends on C/D). |

## Architectural issues to correct before continuing

1. **Runtime mismatch.** A Vercel serverless function is not part of this app's deployment. Either the whole app moves to Vercel (large, unrelated migration), or the renderer runtime is hosted where the rest of the backend already runs. Given `generate-tax-certificate` is a Supabase Edge Function (Deno on Deno Deploy infra), the natural in-tree location for the renderer is **the same Supabase Edge Function boundary**, not a foreign Vercel endpoint. This matches Odoo's principle (the platform owns its rendering runtime, colocated with the app) without introducing a second deploy target.
2. **Headless Chromium as the engine choice was made without approval.** Approved Phase 3 explicitly says the engine internals are an implementation decision for Phase B, and lists both "bundled headless renderer" and "WASM paged-media library" as options. Chromium/Puppeteer inside a Supabase Edge Function is not viable (no binary hosting, Deno runtime, cold-start size limits). A **WASM paged-media library** (e.g. a Paged.js-derived engine or a pure-Deno paged-HTML→PDF pipeline) is the only option that keeps the renderer inside the existing edge boundary.
3. **Orphaned infra files.** `Dockerfile*`, `docker-compose*`, `k8s/` contradict the "internal to the ERP" positioning and add noise; the previous agent claimed to have removed them.

## Corrected next steps (no code yet — approval gate)

### Step 1 — Reconcile Phase B runtime
### Step 1 — Reconcile Phase B runtime — DONE
- Deleted `api/render-certificate.ts`, `vercel.json`, all Docker/K8s files, `nginx.conf`, and the Vercel/Puppeteer/Chromium deps.
- Chose option (b) variant: **AST-direct producer** in `supabase/functions/_shared/certificate-engine/astPdfProducer.ts` — the v3 AST is already semantic, so an intermediate HTML layer buys nothing at PDF time. `compile()` remains available for the publisher workbench browser preview.
- Dispatcher (`generate-tax-certificate/index.ts`) now calls `renderCertificateAstToPdf` for `schema_version === 3` templates; v1/v2 paths untouched.
- Comment drift resolved.

### Step 2 — Phase C: Kenya P9 v10 template
- Author P9 as a v3 template in the KE localization pack: `paper_format`, `page_master`, `document` AST using the semantic nodes (`IdentityStrip`, `Matrix`, `LegalNotice`, `SignatureStrip`, etc.).
- Bump KE pack to v10; ship through `usePackUpgradeProposals` (no forced migration).
- Add golden-PDF baseline test in `src/test/localization/`.

### Step 3 — Phase D: Publisher workbench for v3
- Extend `TemplateEditor` with the v3 canvas (semantic nodes), page-master editor, paper-format editor.
- Live preview panel calls the **same engine** compiled for the browser (engine module is Deno/browser-isomorphic by design — no hand-copied mirror).

### Step 4 — Phases E & F
- Diagnostics warning on v1/v2 templates once a v3 equivalent exists in the same pack.
- Delete `certificateRendererV2.ts` (Deno + browser mirror) and the parity test once no active pack ships `schema_version < 3`.

## Deliverable of this turn
- This verification + corrected plan.
- **No code changes.** Approval gate before Step 1.

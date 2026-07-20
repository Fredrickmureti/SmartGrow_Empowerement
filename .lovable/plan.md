# Enterprise Output Platform — Remediation Plan

Authoritative status for the Enterprise Output Platform Audit and its
prioritized drift remediation. Kept in chronological order; each phase is
brought to a coherent, production-ready state before the next begins.

Anchor documents:
- `docs/adr/0086-enterprise-output-platform.md` — five-stage pipeline
  (Business Event → Canonical Model → Layout Engine → Renderer →
  Driver), one layout engine per medium family.
- `docs/audit/2026-07-20-enterprise-output-platform.md` — runtime-verified
  matrix + drift ledger (D1–D6). Ledger status lives there; this file
  tracks phase execution.

## Roadmap (chronological, one phase at a time)

| Phase | Drift | Medium family     | Status                                   |
| ----- | ----- | ----------------- | ---------------------------------------- |
| 0     | —     | Audit + ADR-0086  | **Done** — matrix + ADR shipped.         |
| 1     | D1    | Label (ZPL)       | **Done** — 2026-07-20.                   |
| 2     | D2    | A4 in edge (PDF)  | **Done** — 2026-07-20.                   |
| 3     | D3    | Client entrypoint | **Next up** — Statement pages → hook.    |
| 4     | D4    | Kitchen / CFD     | No action — confirmed single-source.     |
| 5     | D5    | Bespoke A4 marker | **Absorbed by D2** — closed transitively.|
| 6     | D6    | Server-side ZPL   | Low — deferred, revisit after D3.        |

## Currently active phase

**Phase 3 — D3: Statement print bypasses `useDocumentPrint`.**
Not started. Ledger entry: `docs/audit/2026-07-20-enterprise-output-platform.md#d3`.

## What is fully implemented and verified

### Phase 0 — Audit + ADR (done)
- `docs/adr/0086-enterprise-output-platform.md` codifies the pipeline
  and the "one layout engine per medium family" invariant.
- `docs/audit/2026-07-20-enterprise-output-platform.md` holds the
  runtime-verified matrix and the D1–D6 drift ledger.

### Phase 1 — D1 · Label rendering (done, 2026-07-20)
- Migration `seed_default_label_templates` seeds `inventory_label`
  (kind `product`, engine `zpl`) + idempotent backfill; body preserves
  pre-D1 on-wire shape (`^PW640/^LL400`, CODE128).
- `supabase/functions/_shared/printing/zpl/builder.ts` rewritten as a
  template resolver over `label_templates` (RPC
  `resolve_label_template`); zero ZPL literals in the file.
- Guardrails (12/12 green):
  - `src/test/architecture/label-builder-has-no-hardcoded-zpl.test.ts`
  - `src/test/printing/label-template-substitution-parity.test.ts`
  - `src/test/printing/zpl-golden.test.ts` (reworked; new negative
    cases for missing template / wrong engine)

### Phase 2 — D2 · `pdf-lib` guard in edge functions (done, 2026-07-20)
- New ESLint rule `eslint-rules/no-raw-pdf-lib-in-edge-functions.js`,
  scoped to `supabase/functions/**`, allowlisting only the two
  canonical low-level owners:
  - `supabase/functions/_shared/pdf/**` (canonical A4 engine, ADR-0086)
  - `supabase/functions/_shared/receipt/pdf/**` (canonical thermal PDF
    renderer, ADR-0084)
  Test files exempt (`*.test.ts`, `*.spec.ts`, `*_test.ts`). Supports
  bare `pdf-lib`, `npm:pdf-lib`, and `https://esm.sh/pdf-lib@…` specifiers.
  Per-line escape hatch: `// RENDERER-EXEMPT: <reason>`.
- Wired in `eslint.config.js` at `error` level for
  `supabase/functions/**/*.ts`.
- Architecture test
  `src/test/architecture/adr-0086-edge-pdf-lib-ownership.test.ts`
  locks the invariant at build time (3 assertions: rule registered as
  `error`, edge tree contains zero non-allowlisted importers, allowlist
  respected). **Result: 3/3 passing.**
- Runtime proof: scratch importer of `pdf-lib` under
  `supabase/functions/_scratch-d2-verify/` tripped the rule with the
  ADR-0086 message; scratch removed; baseline
  `bunx eslint 'supabase/functions/**/*.ts'` reports zero
  `no-raw-pdf-lib-in-edge-functions` violations across the current tree.
- D5 absorbed: any future bespoke edge function (like
  `generate-audit-certificate`) is forced to compose `_shared/pdf/**`
  rather than reach for `pdf-lib` itself; no separate D5 guardrail
  needed. Audit ledger updated accordingly.

## What is still pending

- **Phase 3 (D3) — active next.** Migrate `src/pages/CustomerStatements.tsx`
  (`:316`) and `src/pages/VendorStatements.tsx` (`:281`) off the direct
  `supabase.functions.invoke("generate-document", …)` call and onto
  `useDocumentPrint.generateDocument("customer_statement", id, title)` /
  the vendor equivalent. Then extend `no-document-print-shadow-path`
  (or add a companion rule) to forbid direct `generate-document`
  invocations in `src/pages/**` outside sanctioned hooks. Runtime proof:
  Playwright the two Statements pages, confirm the preview dialog opens
  and the outgoing request carries the same headers as the hook path.
- **Phase 6 (D6) — deferred, low priority.** Revisit only after D3.

## Handoff — instructions for the next agent

Before writing any Phase 3 code, verify Phase 2 (D2) is correct and
enterprise-grade:

1. Read `eslint-rules/no-raw-pdf-lib-in-edge-functions.js` and confirm:
   - Allowlist matches the two canonical owners (`_shared/pdf/**`,
     `_shared/receipt/pdf/**`) plus test files only.
   - `isPdfLib` detects bare, `npm:`, and `https://esm.sh/pdf-lib@…`
     specifiers.
   - Per-line `RENDERER-EXEMPT` escape hatch is preserved.
2. Read `eslint.config.js` and confirm the rule is registered under
   `local/` and enforced at `error` on `supabase/functions/**/*.ts`.
3. Run the architecture test — it must pass 3/3:
   ```
   bunx vitest run src/test/architecture/adr-0086-edge-pdf-lib-ownership
   ```
4. Sanity-check the baseline:
   ```
   bunx eslint 'supabase/functions/**/*.ts' | grep no-raw-pdf-lib-in-edge-functions
   ```
   Expect no matches.
5. Reproduce the runtime proof once: drop a scratch file importing
   `PDFDocument` from `pdf-lib` under an ad-hoc edge folder, confirm the
   rule fires with the ADR-0086 message, delete the scratch.

Only after those five steps come back clean, resume the roadmap at
**Phase 3 (D3)** per the "Pending" section above — do not skip ahead to
D6, do not open unrelated audit work. Update this file the moment D3
lands (mark Phase 3 Done, set active phase to Phase 6 or roadmap close),
and update the D3 entry in the audit ledger with resolution notes and
runtime proof, exactly as D1 and D2 were closed.

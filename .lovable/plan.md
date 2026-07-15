# P9 header text is present but clipped — fix the running-header reservation

## What I saw in `amazing.pdf`

The top of the page shows only a sliver of `KENYA REVENUE AUTHORITY — DOMESTIC` and then `TAXES DEPARTMENT` / `TAX DEDUCTION CARD` fully. `APPENDIX 2A` and the first line of the centered heading are visually clipped, but the text is fully selectable — proof it was rendered into the PDF, just outside the visible top margin band.

## Root cause (not a template content bug)

The KE P9 `paper_format` declares:

```text
margin_top: 14 mm
header_height: 22 mm
```

The Paged Media running header (`@top-center { content: element(pageHeader); }`) is painted **inside** the page's top margin area. The compiler currently emits:

```css
@page { margin: 14mm 10mm 10mm 10mm; ... }
```

So the header box has only **14 mm** of vertical room, but the P9 header stack (`APPENDIX 2A` + H2 `KENYA REVENUE AUTHORITY DOMESTIC TAXES DEPARTMENT` + `TAX DEDUCTION CARD` + `YEAR 20…`) needs ~20–22 mm. Anything above the margin band gets clipped by the printable page edge — which is exactly the "invisible but selectable" symptom you described.

The `paper_format.header_height` / `footer_height` fields are already declared on the type and set to sensible values (`22` / `8`) on every template, but `compile.ts` never consumes them. That's the bug.

## Fix — one small compiler change, mirrored, no template surgery

### 1. Teach `compile()` that the effective @page margin must reserve the running-header/footer height

In both compiler mirrors:

- `src/features/localization/lib/engine/compile.ts`
- `supabase/functions/_shared/certificate-engine/compile.ts`

Change the `@page` margin computation to:

```text
effective_top    = max(paper.margin_top,    paper.header_height + 2)
effective_bottom = max(paper.margin_bottom, paper.footer_height + 2)
```

(The `+ 2 mm` is breathing room between the running band and the document body — matches the visual gap on the KRA original.)

Left/right margins are unchanged. This is the semantically correct meaning of `header_height` and is the only reason those fields exist on `PaperFormat`.

Because the fix lives in the country-agnostic engine, it benefits every current and future template (US W-2, GH IRT etc.) — no per-country logic, no Kenya-specific token, no violation of the "no country tokens" invariant.

### 2. Keep both mirrors byte-identical

The parity test `certificate-engine.mirror-parity.test.ts` already guards this. Both files get the same `Math.max(...)` line so the emitted CSS stays identical.

### 3. Snapshot test refresh

`ke-p9-v10.compile.test.ts` already asserts `@page` contains `A4 landscape`. Its deterministic-compile assertion still passes (both compiles use the new formula). No golden HTML lives in the snapshot — just structural `toContain` checks — so nothing else needs updating.

### 4. No DB migration, no pack version bump

The template body in the DB is unchanged. The running header was always structurally correct — it was the renderer that was starving it of vertical room. Existing tenants on pack 10.1.5 immediately benefit the next time they regenerate a P9, because the compiler runs at render time inside `generate-tax-certificate`, not at pack publish time.

## Out of scope

- `keP9.ts` template body (already matches KRA Appendix 2A).
- Publisher editor (`CertificateV3Editor.tsx`) — no new primitives.
- Payroll engine, resolver, monthly matrix, column bindings (10.1.4 fix stands).
- pdf-lib / server PDF pipeline (still Phase D).

## Verification

1. `bun vitest run src/test/localization/certificate-engine.mirror-parity.test.ts src/test/localization/ke-p9-v10.compile.test.ts` — both green.
2. Regenerate the same May 2026 P9 that produced `amazing.pdf`. Expect `APPENDIX 2A`, `KENYA REVENUE AUTHORITY DOMESTIC TAXES DEPARTMENT`, `TAX DEDUCTION CARD`, `YEAR 2026`, `ISO 9001:2015 CERTIFIED` all fully visible in the top band, matching the KRA original.
3. Regenerate a `genericExample` document to confirm smaller headers (`header_height: 12`) are unaffected — `max(12, 12+2) = 14 mm` vs its previous `margin_top`, which will be whichever is larger.

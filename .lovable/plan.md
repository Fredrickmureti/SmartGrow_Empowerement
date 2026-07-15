# KE P9 Certificate — finish the handover

## Findings (audit of prior work)

1. **Renderer + source template are already correct.** `src/features/localization/lib/engine/templates/keP9.ts` (schema v4) is the intended fix:
   - `topHeader` (APPENDIX 2A / KRA / TAX DEDUCTION CARD / YEAR) lives **in document flow**, not in `page_master.header` — so no clipping.
   - `page_master` only defines a `footer`; no running header → no repeat on later pages.
   - The grid unit row emits `Kshs.` for **all 17 amount columns A–O** (line 147).
   - IMPORTANT block is not force-`keep_together`.
   - Compile tests in `src/test/localization/ke-p9-v10.compile.test.ts` already assert all of the above and pass against the source module.

2. **The DB copy of the template was never updated to that source.** Row `localization_pack_certificate_templates.id = 8426e8da-f9c9-48cc-9d60-2dad85566e5c` (`code = P9`, `schema_version = 4`) still contains the **old body with a `page_master.header`** running header (APPENDIX 2A / KRA / ISO 9001 columns) — this is precisely the header that visibly clips in `Systems.pdf` and pushes content onto a blank second page.

3. **The last two publishes did not touch the P9 body:**
   - v10.1.4 (2026‑07‑15 08:31) → `jsonb_set` on `document[3].derived_columns` only.
   - v10.1.5 (2026‑07‑15 09:01) → tightened the `enforce_certificate_template_structure` trigger; no body change.
   Net effect: since the trigger now enforces structure, the update must satisfy it (identity + data + signature blocks). The current source template already does (identity_row nodes, grid = monthly_breakdown/totals, importantBlock closure).

4. **Pack state:** `localization_packs` KE is at `10.1.5`. `pack_versions` shows 10.1.1 → 10.1.5 all `published`. No `2026.8.1` exists; that name from the earlier draft SQL should be discarded — we continue the `10.1.x` sequence the publisher has been using.

5. **Renderer / PDF pipeline itself is not the bug.** Browser preview via paged.js and edge compile mirror are in parity (`certificate-engine.mirror-parity.test.ts`). Once the DB body matches the source, both preview and `generate-tax-certificate` will render the correct layout.

## What to do

Single migration + version bump. No renderer, engine, or template‑source edits.

### 1. Replace DB body with the current source template

- Serialize `KE_P9_V3_TEMPLATE` (from `src/features/localization/lib/engine/templates/keP9.ts`) to JSON.
- In a new Supabase migration, `UPDATE public.localization_pack_certificate_templates SET body = '<literal jsonb>'::jsonb, updated_at = now() WHERE id = '8426e8da-f9c9-48cc-9d60-2dad85566e5c';`
- The `enforce_certificate_template_structure` trigger will validate; body already satisfies required identity/data/signature semantics via the identity rows, grid (monthly_breakdown + totals), and closing block.

### 2. Bump pack version

- `UPDATE public.localization_packs SET version = '10.1.6', updated_at = now() WHERE id = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';`
- Insert a matching `pack_versions` row (`version = '10.1.6'`, `status = 'published'`, `published_at = now()`, `pack_id = <KE pack id>`) mirroring the shape of the 10.1.5 row.

### 3. Verify

- Run `vitest` targeted at `src/test/localization/ke-p9-v10.compile.test.ts` and `certificate-engine.*.test.ts` (should still pass — no code changed).
- Re-query the DB row: `body->'page_master'->'header'` must be `NULL`; `jsonb_array_length(body->'document')` = 10; count of `Kshs.` unit cells in the grid header = 17.
- Regenerate the certificate for a sample tenant via `generate-tax-certificate` and confirm: single landscape page, top heading visible, `Kshs.` under every amount column, no blank middle page.

## What NOT to do

- Do **not** re-run the earlier draft SQL from `.lovable/plan.md` (it targeted a non-existent `2026.8.1` sequence and pre-dates the 10.1.5 trigger tightening).
- Do **not** edit `keP9.ts`, `compile.ts` (browser or edge mirror), `resolver.ts`, `types.ts`, `certificateRenderer.ts`, or `generate-tax-certificate` — the source of truth already models the official KRA layout.
- Do **not** introduce Kenya-specific logic in the engine or renderer. All fixes stay in pack data.

## Technical details

- Table: `public.localization_pack_certificate_templates`
- Template row id: `8426e8da-f9c9-48cc-9d60-2dad85566e5c` (code `P9`, pack KE)
- Pack row id: `a1b2c3d4-e5f6-7890-abcd-ef1234567890`
- New pack version: `10.1.6`
- Body payload: the full serialized `KE_P9_V3_TEMPLATE` object (schema_version 4, paper A4 landscape, page_master with footer only, 10 document nodes).
- Trigger to satisfy: `enforce_certificate_template_structure` (added in migration `20260715090135`).

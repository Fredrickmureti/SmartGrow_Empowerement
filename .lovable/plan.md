## Diagnosis

The upgrade did not fail silently: your installed Kenya pack row is already on `10.0.0`.

The repeated P9 issue is coming from two implementation gaps:

1. **The global pack header still says `2026.5.0`.** `localization_packs.version` was not bumped when v10.0.0 was published, so the Localization UI can still display `v2026.5.0` even though the installed tenant row says `10.0.0`.
2. **The generator/renderer is still effectively using the old section contract for P9.** The P9 template has new `body.blocks[]`, but it also still has old `body.sections[]`. The generator still enforces and collects data from `sections[]`, and the generated PDF text proves the table is still the old section-style output with old column keys.
3. **The new monthly matrix column keys do not match the live payroll line rule codes.** The live payroll data has codes like `basic`, `housing_allowance`, `transport_allowance`, `shif`, `paye`, `housing_levy`, `nssf`; the v10 template asks for `basic_salary`, `gross_pay`, `paye_gross`, `personal_relief`, etc., so the monthly RPC returns zeros for the columns the template asks for.

## Fix plan

1. **Normalize active version display**
   - Update the pack-publish/promote path so `localization_packs.version` reflects the latest current published version.
   - Ensure tenant Localization views prefer `installed_localization_packs.pack_version` for the tenant’s actual installed version, not the pack catalog header.

2. **Make v2 block templates authoritative**
   - In `generate-tax-certificate`, when `body.schema_version >= 2` and `body.blocks[]` exists:
     - validate the v2 block contract instead of requiring legacy `sections[]`;
     - collect monthly rule codes only from v2 blocks;
     - pass the v2 template directly to the v2 renderer.
   - Keep legacy `sections[]` handling only for pre-v2 templates.

3. **Repair the Kenya P9/P9A template data mapping**
   - Add a migration that updates P9/P9A v10 templates so their `monthly_matrix` columns bind to the live payroll rule codes:
     - `basic` for A basic salary;
     - earnings/allowance codes for gross-pay derivation;
     - `housing_levy`, `shif`, `nssf`, `paye` for statutory columns;
     - derived columns for gross pay, chargeable pay, and net PAYE.
   - Keep KRA-facing column headers A–O, but separate display headers from internal rule-code keys.

4. **Prevent old issued certificates being reused**
   - Bump `CERTIFICATE_RENDERER_VERSION` and include a template body/hash marker in the payload so existing issued PDFs are automatically superseded/rerendered after template changes, even when the user forgets to tick regenerate.

5. **Add regression checks**
   - Add/adjust targeted tests for:
     - v2 templates not depending on legacy `sections[]`;
     - v2 monthly code extraction using block columns and derived args;
     - Kenya P9 rendering non-zero rows from live rule-code aliases.

## Expected result

After implementation, Localization will no longer misleadingly show the old active version, P9 generation will use the v10 block/matrix renderer, and generated P9 PDFs will populate the monthly rows instead of repeating the old blank/zero layout.
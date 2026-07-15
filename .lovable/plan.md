I rechecked the uploaded PDFs visually before planning the fix.

What I confirmed:
- `amazing-2.pdf` has 3 pages; page 2 is completely blank.
- The system header is still clipped: the top text is present/selectable but visually cut off, especially around `APPENDIX 2A` / `KENYA REVENUE AUTHORITY...`.
- The original PDF is 1 page and its top section is normal visible content, not a clipped repeated running header.
- The original has a `Kshs.` currency row across the amount columns; the system template only shows `Kshs.` under the Defined Contribution Retirement Scheme columns because the P9 header row is authored with unit cells only for E1/E2/E3.

Plan:

1. **Stop clipping the P9 top header**
   - Move the Kenya P9 top header out of the repeating page-margin header band and into the normal first-page document flow for this template.
   - Keep only the footer in the page master.
   - This removes the “selectable but invisible” margin-box clipping problem and also prevents the header from repeating on the later notes page.

2. **Match the official KRA header grid more closely**
   - Rebuild the P9 grid header stack so the unit row includes `Kshs.` for every amount column, not only E1/E2/E3.
   - Keep the E retirement group structure, but make the visible row order closer to the original: label row → currency row → letter/group row → E1/E2/E3 instruction row.

3. **Remove the extra blank page / force one-page statutory layout**
   - Compact the P9 template spacing and typography enough for the identity block, monthly grid, totals, and IMPORTANT/Attach notes to fit on one landscape page like the original.
   - Remove the over-aggressive `keep_together` behavior from the IMPORTANT block that is causing the notes to be pushed after a blank page.

4. **Ship through the localization pack**
   - Apply a Supabase migration to update the stored KE P9 certificate template body.
   - Bump the Kenya localization pack version so the tenant receives the corrected template through the normal update flow.

5. **Verification**
   - Add/update focused compile tests for the canonical KE P9 v4 template:
     - all expected `Kshs.` cells are emitted,
     - the P9 header is not in the running page header,
     - the footer still exists,
     - no required payroll bindings regress.
   - Regenerate a sample PDF, convert it to images, and visually verify:
     - header is fully visible,
     - `Kshs.` appears across the amount columns,
     - no blank middle page is produced.
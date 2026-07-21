# ADR-0088 — Label geometry is media-relative

- Status: Accepted (2026-07-21)
- Related: ADR-0085 (rendering ownership), ADR-0086 (Line AST), ADR-0087
  (drivers own the paper envelope)

## Context

ADR-0087 moved paper geometry (`^PW`/`^LL`, EPL `q`/`Q`) out of template
bodies and into the driver, so the paper envelope always scales to the
resolved `media_profile` × `printer_profile.dpi`. But the CONTENT
inside the envelope was still authored in raw device dots
(`^FO20,20`, `^CF0,28`, `^BY2,2,80`), which are only correct at one
particular DPI. When an operator switched a 50×30 mm label roll from
8 dpmm (203 dpi) to 6 dpmm (152 dpi), the paper envelope correctly
shrank in dots — but the content stayed at the same absolute dot
positions, overrunning the right edge and clipping the barcode. This
was the exact defect reported on 2026-07-21.

## Decision

Label template bodies express geometry in physical **millimetres**.
`labelDispatch.renderTemplateBody` resolves an mm-token pack against
the resolved `media.dpi` before the body reaches the driver:

| Token           | Meaning                                                              |
|-----------------|----------------------------------------------------------------------|
| `{{mm:n}}`      | `round(n × dpi / 25.4)` — coordinate or length                       |
| `{{cf:n mm}}`   | same — `^CF` font height                                             |
| `{{bh:n mm}}`   | same — barcode height                                                |
| `{{by:n mm}}`   | `^BY` module width in dots, clamped 1–10 (printer-realistic range)   |
| `{{hri_flag}}`  | `'Y'`/`'N'` — barcode HRI toggle, driven by policy not the template   |

A new column `label_templates.geometry_mode text` distinguishes:

- `mm` — body uses the tokens above. Platform-seeded templates land here.
- `dots-legacy` — body uses raw dots. Default for anything already in
  the database. Backwards compatible.

Drivers keep their current contract (bytes/zpl in, wire bytes out) —
mm resolution is a pure string transform inside the dispatcher.

## Consequences

- The same body renders at the correct physical size on 152, 203, 300,
  and 600 dpi hardware. The 6-dpmm cutoff defect cannot recur.
- Operators authoring in the Platform → Hardware → Labels editor think
  in millimetres, the natural unit for label rolls, price rails, and
  pallet placards.
- Legacy bodies (`geometry_mode = 'dots-legacy'`) print unchanged;
  migration is opt-in per template.

## Guardrails

- `src/test/printing/label-body-mm-scaling.test.ts` — same body at
  152/203/300 dpi yields dot coordinates matching `n × dpi / 25.4`,
  and rightmost content always stays inside a 50 mm envelope.
- Seed function `public.seed_default_label_templates()` inserts all
  seven canonical templates (`product_label`, `shelf_label`,
  `lot_label`, `bin_label`, `receiving_label`, `pallet_label`,
  `shipping_label`) with `geometry_mode = 'mm'` and
  `media_profile_id = NULL`.

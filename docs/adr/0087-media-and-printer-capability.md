# ADR-0087 — Media & Printer Capability as First-Class Concepts

Date: 2026-07-21
Status: Accepted
Supersedes: parts of ADR-0086 that co-located paper geometry with
`printer_profiles.paper_format` and `label_templates.width_mm/height_mm`.

## Context

ADR-0086 built the enterprise output platform on three canonical
rendering pipelines (paged PDF, thermal `Line[]`, label templates) and
one label registry (`label_templates`). The subsequent audit
(`docs/audit/2026-07-20-enterprise-output-platform.md`, drift items
D7–D11) found that the layer *below* the templates was missing:

- Physical paper geometry was duplicated across
  `printer_profiles.paper_format` (business-ish enum),
  `label_templates.width_mm/height_mm` (metadata only), and
  `device_assignments.config.{dpi,widthMm,heightMm}` (per-device
  override) — with none of the three authoritative.
- Template bodies embedded absolute dot coordinates (`^PW640`, `^LL400`,
  `^FO20,20`), so seeding a body against a `640×400` dot canvas at
  203 dpi worked on a 80×50 mm roll and silently mis-scaled on every
  other size.
- `printer_profiles` described one paper choice rather than the
  hardware it drove — no `dpi`, no `command_language`, no
  `supported_media[]`, no `resolution_dpmm`.
- `label_templates`' unique key was `(org_id, branch_id, template_key)`,
  so a `shelf_edge` template could only exist in one size per org.

Net: the label pipeline was canonical from `label_templates` on, and
architecturally deficient below it. Every "changing label size doesn't
scale content" complaint bottomed out here.

## Decision

Introduce **two first-class records** and re-key labels on them:

```text
media_profiles          printer_profiles                label_templates
──────────────          ────────────────                ───────────────
id                      id                              id
org_id                  org_id                          org_id, branch_id
code                    label                           kind, template_key
width_mm, height_mm     command_language ZPL|EPL|ESC    media_profile_id  (new)
orientation             dpi 203|300|600                 engine
gap_mm                  margins_mm                      body (content
kind label|receipt|     supported_media_ids[]              tokens only —
     sheet|continuous   capabilities[]                     NO envelope
                        transport, address                 commands)
                        driver key                       version, active
```

The **rendering contract** between the driver and the template changes
in exactly two places:

1. **Template body owns content tokens, not paper.** No `^PW`, no
   `^LL`, no EPL `q<dots>` / `Q<dots>,<gap>`. The body is a fragment
   the driver places inside a media-sized frame.
2. **Driver owns the paper envelope.** Given the resolved
   `media_profiles` row and the `printer_profiles.dpi`, every label
   driver (`ZplLabelDriver`, `EplLabelDriver`) — and the renderer-side
   `BrowserHardwareAdapter` fallback — computes
   `dpmm = dpi / 25.4`, `widthDots = round(mediaWidthMm * dpmm)`, and
   injects the envelope right after `^XA` (ZPL) or as the first two
   lines (EPL). Any envelope already present in the body is stripped
   before writing.

## Consequences

Positive
- Adding a new label size = insert one `media_profiles` row and
  reference it from an existing template. No code change, no template
  body edit, no driver change.
- Adding a new printer model = insert one `printer_profiles` row with
  `command_language`, `dpi`, and `supported_media_ids[]`. Drivers
  discover the hardware from the profile, not from ad-hoc
  `device_assignments.config`.
- The same content body prints correctly on 50×30, 80×50, and
  102×152 mm labels on both 203 and 300 dpi printers, on all three
  transports (Electron main process, LAN agent, browser adapter).
- `label_templates.media_profile_id` participates in the unique key,
  so one business intent (e.g. `shelf_edge`) can register multiple
  bodies for different physical sizes.

Negative
- `printer_profiles.paper_format` is retained as a legacy column for
  the receipt PDF pipeline and is deprecated for label routing. A
  follow-up will migrate remaining readers (`PrinterProfilesCard.tsx`,
  `PrintingSettings.tsx`, `PostPaymentScreen.tsx`) to consume
  `supported_media_ids[]` instead.
- Body-embedded envelope commands in legacy templates are silently
  stripped by the driver. This is deliberate: the resolved media wins.
  A build-time guardrail (`label-templates-have-no-envelope.test.ts`)
  keeps new bodies clean.

## Ownership matrix

| Concern                        | Owner                        | Editor surface                       |
| ------------------------------ | ---------------------------- | ------------------------------------ |
| Physical paper geometry        | `media_profiles`             | `/platform/hardware/media`           |
| Hardware capability            | `printer_profiles`           | `/platform/hardware/devices`         |
| Business layout (content only) | `label_templates.body`       | Label template editor                |
| Workflow → printer routing     | `printer_workflow_bindings`  | `/platform/hardware/devices`         |
| Envelope emission              | Label drivers + browser adapter | (code — not user-editable)        |

## Guardrails

- `src/test/printing/label-templates-have-no-envelope.test.ts` — no
  seeded body ever contains `^PW/^LL/q<n>/Q<n>`.
- `src/test/printing/printer-profile-hardware-shape.test.ts` — dispatch
  reads capability from `printer_profiles`, not `device_assignments.config`.
- `src/test/printing/media-profile-required-on-label-render.test.ts` —
  media geometry flows from resolved printer through to driver payload.
- `src/test/printing/label-envelope-parity.test.ts` — Electron main,
  EPL, and browser adapter agree on the envelope math.

## Migration reference

- `supabase/migrations/20260721001823_*.sql` — creates `media_profiles`
  (with grants, RLS, per-org auto-seed trigger), extends
  `printer_profiles` with `command_language`, `dpi`, `margins_mm`,
  `supported_media_ids[]`, `capabilities[]`, adds
  `label_templates.media_profile_id`, and rewrites
  `resolve_label_template` to a 4-arg signature with media fallback.
- `supabase/migrations/20260721002219_*.sql` — rewrites
  `seed_default_label_templates` to link each seeded body to a media
  profile and to ship envelope-free bodies.
- `supabase/migrations/20260721005711_*.sql` — Phase 13 fix.
  Nulls `media_profile_id` on existing default org-scope rows, adds
  the resolver's `rnk=5` last-resort arm, and rewrites the seed
  function to insert `media_profile_id = NULL` for future orgs.

## Addendum · Defaults are media-agnostic (Phase 13, 2026-07-21)

A real-world failure surfaced this defect: an org with the default
`product_label` template but no `printer_workflow_bindings` toasted
"No label template registered for key 'product_label'". Root cause: the
Phase-9/10 seeder inserted default rows with a pinned `media_profile_id`.
When callers had no printer/workflow binding, the resolver received
`p_media_profile_id = NULL` and every candidate row scored `rnk=99`
under the original 4-tier CASE, so zero rows returned — indistinguishable
at the dispatch layer from a genuinely missing template.

The invariant is now explicit:

> **Default templates MUST be media-agnostic.** Rows with
> `is_default = true AND branch_id IS NULL` MUST have
> `media_profile_id = NULL`. Only branch overrides and explicit media
> variants (`is_default = false`) may pin `media_profile_id`.

This invariant is enforced by three complementary mechanisms:

1. **`seed_default_label_templates()`** inserts `media_profile_id = NULL`
   for every new organization (migration `20260721005711_*`).
2. **Existing rows** were repaired by the same migration: an UPDATE
   nulls `media_profile_id` on every default org-scope row.
3. **Resolver safety net (`rnk=5`).** Even if a future migration or
   manual insert re-pins a default row, the resolver's last-resort arm
   still returns the row when the caller has no media, converting a
   silent-drop bug into a slightly-mis-scaled label (which is
   noticeable, correctable, and non-catastrophic).

The `rnk=5` arm is documented as "last-resort" in the SQL and is
guarded by `src/test/printing/resolve-label-template-media-agnostic-default.test.ts`.
Do not delete it as dead code — it is the forward-compatibility contract
that keeps this class of defect from recurring.

Callers with a resolved media (from `printer_profiles.supported_media_ids[0]`
or an explicit `mediaProfileId`) still match `rnk=1..4` and receive the
media-specific variant when one exists. The safety net only fires when
`p_media_profile_id IS NULL` — the exact failure mode Phase 13 addressed.

Dispatcher error taxonomy at `src/services/printing/labelDispatch.ts`:

- **Zero rows exist** for `(org_id, template_key, active)` → plain
  `no label template registered for key '<key>'` message.
- **Rows exist but resolver returned none** → sharpened error naming
  the branch and media scope, pointing operators at Platform → Hardware
  and instructing them to bind a workflow or pass `mediaProfileId`
  explicitly.

Guarded by `src/test/printing/label-dispatch-error-taxonomy.test.ts`.

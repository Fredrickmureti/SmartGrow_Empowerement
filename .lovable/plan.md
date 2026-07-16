# Tax Certificates — Enterprise UX Overhaul

## Verdict (audit summary)

**Current architecture (`src/pages/hr/payroll/TaxCertificates.tsx`, 714 lines, single component).**
Renders five stacked full-width `Card`s in this order:

1. Localization health (4 tiles) — always visible
2. Year readiness (5 tiles + status banner) — always visible
3. **Coverage** (5 tiles) — *conditionally rendered when `templateCode` is set*
4. **Employer reconciliation** (4 tiles) — *conditionally rendered when `templateCode` is set*
5. Generate (template + year + employee table + actions)
6. Generated certificates table

**The concrete UX defect.** Sections 3 and 4 are gated on `templateCode`. Selecting a template in section 5 injects ~360 px of content *above* the Generate card, pushing the primary action (and the employee table the user was just about to interact with) below the fold. This is the layout-shift complaint. Focus is lost, scroll position is wrong, and the workflow inverts (choose template → get punished with more reading).

**Deeper problems the shift exposes.**
- **Wrong hierarchy.** Localization health is chrome, not a daily task, yet it holds prime real estate every visit. Enterprise pattern (Odoo/Workday/SuccessFactors): compliance context collapses to a status strip once healthy; only expands on incidents.
- **Readiness + coverage + reconciliation are the same story** (is FY *n* fileable?) split across three cards.
- **No workspace stability.** Every card is `w-full` stacked; template selection is a global state change with global layout consequences.
- **Primary action is buried.** The Generate button lives ~5 scrolls down even on desktop, and after template selection moves further.
- **Progressive disclosure is inverted.** Advanced compliance detail (reconciliation variance) is always-on for anyone who picks a template, while the actual generation controls are always demoted.

## Recommended redesign

Adopt a **two-column compliance workspace** with a **fixed skeleton** — the layout does not grow when the template changes; content swaps *inside* stable panels.

```text
┌───────────────────────────────────────────────────────────────┐
│ Header: Tax Certificates    [FY selector] [Pack: KE ▾ healthy]│  ← compact status strip
├──────────────────────────────────────────┬────────────────────┤
│ LEFT  (main, min-w-0)                    │ RIGHT (aside 340px)│
│                                          │                    │
│ ┌ Issue certificates ───────────────────┐│ ┌ Compliance ─────┐│
│ │ [Template ▾] [FY ▾]  (sticky toolbar) ││ │ FY {y} readiness ││
│ │ Employee table (virtualized-ready)    ││ │ • Periods 12/12  ││
│ │ [Regenerate] [Generate] [Year-end]    ││ │ • Committed 12   ││
│ └───────────────────────────────────────┘│ │ • Blocking 0     ││
│                                          │ │ • Stale 0        ││
│ ┌ Generated certificates ───────────────┐│ │ [Ready ✓]        ││
│ │ table … download / status / submit    ││ └──────────────────┘│
│ └───────────────────────────────────────┘│ ┌ Coverage ────────┐│
│                                          │ │ 42 issued / 3 miss│
│                                          │ │ 0 stale / 1 super │
│                                          │ └──────────────────┘│
│                                          │ ┌ Reconciliation ──┐│
│                                          │ │ Cert ↔ Return ✓  ││
│                                          │ │ Variance: 0.00   ││
│                                          │ │ [Details ▸]      ││
│                                          │ └──────────────────┘│
└──────────────────────────────────────────┴────────────────────┘
```

### Key moves

1. **Kill layout shift.** Coverage and Reconciliation move into the right rail as *always-present* compact panels. When no template is selected they show a neutral "Select a template to see coverage" state — no mount/unmount, no height change.
2. **Localization → status chip in the header.** Healthy pack collapses to a single chip with the pack name + version. Click opens a `Popover` with the four tiles that used to occupy an entire card. Pending upgrades or missing pack promote it back to a full alert banner (progressive disclosure driven by state, not by default).
3. **Generate is the visual center.** Moves to the top of the left column. Template + FY become a **sticky toolbar** inside that card so they remain reachable while the user scrolls the employee list. Primary action (`Generate`) and secondary (`Year-end batch`) live in a footer action bar on the card, always visible.
4. **Year readiness becomes the aside's top panel.** Same five metrics, denser vertical layout, block banner remains for blocking findings (the one place a full-width alert is warranted).
5. **Coverage and Reconciliation are aside panels.** They update *in place* on template change — no scroll jump, no injected DOM above the fold.
6. **Generated certificates table** stays in the left column below Generate — the natural read-order after issuing.
7. **Responsive.** Below `lg`, aside collapses under the main column in the same order (Compliance → Coverage → Reconciliation → Generated list). Sticky toolbar becomes non-sticky on mobile to avoid iOS scroll issues.
8. **Focus & scroll stability.** After template selection, focus stays on the template trigger; no `scrollIntoView`; the employee table is unaffected because it hasn't moved.

### Why this is objectively better

- **Zero layout shift** on template change — the aside panels swap content, not existence. Matches Workday's "context rail" and Odoo Payroll's "right-side smart buttons" pattern.
- **Primary action always above the fold** on 1280×800 and larger, and reachable via sticky toolbar on smaller viewports.
- **Progressive disclosure** — healthy compliance context compresses; problems expand. Same principle SAP SuccessFactors uses for its Compliance Center.
- **Same information density, better hierarchy** — nothing is removed; readiness/coverage/reconciliation are reframed as *supporting context* to the act of issuing, not as gates the user must scroll past.

## Implementation

Single file changes plus one new subcomponent for the aside. No hook, query, or edge-function changes — this is presentation only.

### Files

- **`src/pages/hr/payroll/TaxCertificates.tsx`** — restructure JSX only. Reuse all existing hooks (`useLocalizationHealth`, `useYearReadiness`, `useCertificateTemplates`, `useTaxCertificates`, `useCertificateReconciliation`, `useCertificateSubmissions`, `useGenerateTaxCertificate`). Keep `StatTile` (move to `./TaxCertificates/StatTile.tsx` or inline).
- **New `src/pages/hr/payroll/TaxCertificates/ComplianceRail.tsx`** — the right-side aside: Readiness panel, Coverage panel, Reconciliation panel. Accepts `{ readiness, coverage, recon, blockedReasons, templateCode, selectedTemplate, fiscalYear }`. Renders neutral empty state when `templateCode` is falsy for Coverage/Reconciliation (no unmounting).
- **New `src/pages/hr/payroll/TaxCertificates/LocalizationStatusChip.tsx`** — header chip + `Popover` with the 4 pack tiles. Renders a full-width alert `Card` instead of a chip when `!health?.pack_id` or `pending_upgrades > 0`.
- **New `src/pages/hr/payroll/TaxCertificates/GenerateCard.tsx`** — extracts the current Generate `Card`: sticky top toolbar (Template, FY, regenerate toggle), employee table, footer action row with Generate + Year-end. Uses the same handlers passed down as props.
- **`src/pages/hr/payroll/TaxCertificates/GeneratedList.tsx`** — extracts the existing generated-certificates table with download/submission columns.

Layout uses the existing grid convention (`grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6`, cf. `RecordShell`).

### Non-functional constraints (must hold)

- No new API/RPC calls; identical query keys and cadence.
- No changes to `useTaxCertificates` filter semantics — the URL sync (template + from) stays intact.
- All existing icons/badges preserved (`Package`, `ShieldAlert`, `Scale`, `AlertTriangle`, `CheckCircle2`).
- Keyboard: template select retains focus after change; sticky toolbar uses `position: sticky` with `top-0` inside the card, not the viewport, so it doesn't fight the app header.
- Accessibility: aside is `<aside aria-label="Compliance context">`; blocking-findings banner keeps its `role` semantics (alert-like via border + icon, same as today).
- Responsive: `< lg`, aside stacks below main; sticky toolbar disabled via `lg:sticky`.
- No visual token deviations — reuse existing shadcn `Card`, `Badge`, `Popover`, `Sheet` primitives.

### Out of scope (explicitly)

- Backend, hooks, RLS, edge functions.
- Any change to the certificates data model, submission flow, or template selection semantics.
- Visual theme, colors, typography.
- The `/me/payslips` and `MyTaxCertificates` employee-facing pages.

## Verification

- `bun run typecheck` clean.
- Manual: with no template selected, aside shows Readiness populated + Coverage/Reconciliation neutral empty state. Selecting a template updates only the aside content and the Generate card title — Generate button does not move by a single pixel. Re-selecting or clearing the template does not scroll or reflow the left column.
- Playwright screenshot at 1280×1800 before/after template selection to confirm zero layout shift for the Generate card's bounding box.

# Consolidation Traceability — Wave Deliverable

Every consolidated figure in this product is reachable back to the posted
journal line and the source document that created it, without leaving the
report. This document is the lineage map for that guarantee, the record of
what the wave corrected, and the contract the next consolidation brick must
keep.

## The one drill chain

```text
figure on a consolidated surface
  └─ in-place dialog scoped to the company that owns the records
       └─ DrillDownDialog  (get_general_ledger, _business_id = that member)
            └─ TransactionPreviewDrawer  (the journal entry / source doc)
                 └─ "View full record"  (the exact document, canonical route)
```

There is exactly one drill primitive (`components/reports/DrillDownDialog.tsx`)
and one preview drawer (`components/finance/TransactionPreviewDrawer.tsx`).
Consolidation surfaces extend them by passing `businessId` / `businessName`;
they do not clone them. Deep links (`lib/reports/crossEntityDrill.ts`) are the
secondary affordance, centralized in the drill primitive — never the primary
way to inspect a number.

## Per-surface lineage map

### Cross-Company Comparative — `pages/reports/Consolidation.tsx`
| | |
|---|---|
| Figure | Income / Expenses / Net income, one row per company |
| Authority | `fetchGLTotals(org, from, to, business)` — posted GL, same engine as the formal reports |
| Company set | `useAllowedBusinessIds` — an unentitled company is never listed |
| Drill | `EntityPnlBreakdownDialog` (accounts behind the figure) → `DrillDownDialog` → drawer → full record |
| Not-a-consolidation rule | Figures are never summed or translated across currencies, on screen or in the artifact |

### Consolidated Trial Balance — `pages/reports/ConsolidatedTrialBalance.tsx`
| | |
|---|---|
| Figure | Group line totals, expandable to member contributions |
| Drill | Member contribution row → `DrillDownDialog` with `businessId: c.business_id` |
| Opens nothing, and says why | The group total row (owns no records — it is an addition) and the CTA residual (`!line.is_residual`, a translation artefact, not a posting) |

### Consolidated Statements — `pages/reports/ConsolidatedStatements.tsx`
| | |
|---|---|
| Figure | Income statement / balance sheet lines for the group |
| Drill | `MemberContributionDialog` (which member contributed what) → `DrillDownDialog` on that member's own books → drawer → full record |

### Intercompany — `pages/reports/ConsolidationIntercompany.tsx`
| | |
|---|---|
| Figure | Reconciliation pairs and activity rows |
| Drill | `DrillDownDialog` with `businessId: r.declaring_business_id` — the posting company's own account, never the counterparty's |
| Gate | `activityBlocked` when the server did not authorize the read |

### Eliminations — `components/finance/EliminationEvidencePanel.tsx`
| | |
|---|---|
| Figure | Each elimination leg: rule, both companies, both accounts, original and eliminated amount, generated adjustment |
| Drill | Entry → `TransactionPreviewDrawer`; account → `DrillDownDialog` with `businessId: r.declaring_business_id` |
| Gate | Every affordance sits inside a per-row `r.viewer_can_open_ledger` branch |
| Difference legs | Explain their policy (`DifferenceExplanation`, `tolerance_amount`) instead of fabricating evidence |

## Permission evidence

The drill primitive now names a company, so the guarantee is explicit in SQL,
not implicit in the UI. `get_general_ledger` raises `42501` unless all of
`finance_can_read_scope`, `finance_can_read_branch` and
`finance_can_read_financials` pass for the named business, then re-checks that
the business belongs to the organization.

- `finance_can_read_scope` resolves a named business through
  `user_can_access_business(auth.uid(), _business_id)`.
- An unscoped (org-wide) run is refused unless the caller can reach **every**
  active business — an aggregate can never silently include an unentitled
  company.
- `finance_can_read_financials` additionally requires `financials:read` on that
  business.

A viewer without Company B therefore reaches nothing of B's through a
consolidated drill, whatever the client sends. Client-side gating
(`viewer_can_open_ledger`, `useAllowedBusinessIds`) is a rail on top of that
boundary, not the boundary.

## Artifact integrity

All five surfaces export through the single branded pipeline
(`ReportExportButtons` + `ExportConfig` → `ReportExportService`). No page
assembles a `Blob`, calls `jsPDF`, or brands its own masthead — `companyName`
was removed from `ExportConfig` precisely so branding can only come from
`getOrganizationBranding()`. Every artifact carries a title and a period stamp
(`dateRange`, or `asOf` for point-in-time reports), and the comparative
artifact repeats the on-screen caveat with the currencies actually present,
each amount formatted in its own company's currency.

## Corrected assumptions from earlier in the wave

1. Typechecks run against the solution-style `tsconfig.json` include no files
   and prove nothing. Verification uses `tsconfig.app.json`.
2. Phase 4D was reported complete but did not compile: the evidence panel
   called `setPreview` / `setDrillConfig` without declaring them or rendering
   the dialogs. Fixed.
3. The Phase 5 export used a `label` property that `ExportColumn` does not
   have. Fixed to `header` + `width`.
4. Tests asserted the old navigate-away URL contract, and one counted
   `navigate(` calls one-for-one against guards — a heuristic that breaks the
   moment a row gains a second, correctly-gated affordance. Rewritten to
   assert the gate, not the call count.

## Contract for the next consolidation brick

- Drill-down = preview → drawer → "View full record" on the exact document, in
  place. Route links are deep links, not drill-downs.
- Extend the Finance primitives; never clone them into consolidation-specific
  drawers or previews.
- No accounting arithmetic in the browser; no second reporting engine.
- A figure that owns no records opens nothing and says why.
- Every affordance is permission-gated client-side as a rail; the server RPC
  guards remain the boundary.
- Any new surface joins `consolidation-artifact-integrity.test.ts` and
  `consolidation-cross-entity-drill.test.ts` in the same change.

## Readiness

The five consolidation surfaces satisfy the contract, are covered by 94
architecture assertions, typecheck clean under `tsconfig.app.json`, and build
green. The next brick can be started on this foundation.

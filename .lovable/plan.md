
# Ghana Localization Pack — Guided Publication & Publisher Audit

This is an investigation + workshop, not a code-first task. No Ghana rows get written until you and I have walked through the platform end-to-end and agreed on each artifact.

## Ground rules

- **No tenant backfills. No patching installed packs.** Ghana ships as a brand-new pack + version through the normal publish pipeline.
- **Versioning, upgrade proposals, and tenant overrides stay intact** — every change respects ADR 0010 and ADR 0056.
- **Platform > pack.** If Ghana exposes a publisher weakness that will also hurt Nigeria/Uganda/TZ/ZA, we fix the publisher (blockers + high-value UX wins) rather than working around it in Ghana's payload.
- **Business language first.** Every artifact is explained to you as an accountant before any JSON is authored.

## Phase 1 — Reverse-engineer the publishing engine (read-only)

Deliverable: an internal map of every moving part, cited to files, so I can reason about the platform without guessing. I trace, in this order:

1. **Authoring surface** — publisher routes, `PackEditorShell`, `TemplateEditor`, `ReturnTemplateEditor`, `TaxTemplatesEditor`, `AccountTemplatesEditor`, `RemittanceSchedulesEditor`, `SchemaForm`, `TokenPicker`, `RuleForm`, `PackHealthPanel`, `PackDiffView`, `PreviewPanel`.
2. **Data model** — `localization_packs`, `localization_pack_*_templates`, `pack_versions`, `pack_rule_type_schemas`, `pack_token_registry`, `pack_upgrade_proposals`, `pack_audit_log`, `pack_return_run_audit`, `pack_publisher_grants`, `pack_requirements`, `pack_rule_conflicts`, `pack_account_roles`, `pack_migration_log`, `payroll_statutory_rules`, `statutory_authorities`, `business_event_outbox`, `installed_localization_packs`.
3. **Edge functions** — `validate-localization-payload`, `publish-localization-pack-version`, `install-localization-pack`, `process-localization-outbox`, `compute-payroll`, `generate-tax-certificate`, `generate-statutory-return`, and the shared `renderTokens.ts`.
4. **Validation & guards** — JSON Schemas, `trg_assert_pack_payload_valid`, publish-time lint gate, `no-literal-rule-codes-in-engines` ESLint rule, `no_country_named_functions_test.sql`, `pack_income_tax_deductibility_test.sql`, `payroll_gl_readiness`.
5. **Tenant consumption** — install pipeline, override tables, `pack_upgrade_proposals` inbox, `MissingMappingsDialog`, `PayrollGlReadinessBanner`, `payroll_diagnostics` (`TOKEN_UNRESOLVED`), return-run 8-state machine.

Output: a short **Engine Map** document I share back in chat before we author anything.

## Phase 2 — Explain the engine to you, accountant-first

For each publisher page and each data object, I give you:

- **Business purpose** (what event this models, e.g. "authority declares a new PAYE band")
- **Who authors it** (publisher role vs tenant)
- **Who consumes it** (payroll engine? certificate renderer? return runner? GL poster?)
- **What breaks if it's missing** (blocked run, unresolved token, missing filing, drift)
- **Override boundary** (pack-owned vs tenant-overridable)

No JSON in this phase. Diagrams and prose only.

## Phase 3 — Publisher audit

I score the publisher against enterprise-publisher expectations and produce a **Publisher Audit** doc with findings tagged:

- **Blocker** — Ghana cannot be published cleanly without fixing it. We fix now.
- **High-value UX win** — clearly helps every future country (NG/UG/TZ/ZA). We fix now, small scope.
- **Deferred** — larger rework; becomes/extends an ADR (candidates for the ADR 0056 P2 track).

Dimensions scored: intuitiveness for a non-developer, JSON/DB leakage, guided flow, validation strength, dependency visualization, preview fidelity vs runtime, publish-time gate quality, upgrade proposal legibility.

## Phase 4 — Ghana research

Authoritative-source research (GRA, SSNIT, Ministry of Finance, Bank of Ghana, Ghana Revenue Authority publications, current Act references). I produce a **Ghana Compliance Brief** covering the full compliance surface you selected:

- PAYE (resident bands, non-resident flat rate, bonus tax rule, overtime tax rule)
- SSNIT Tier 1 (5.5% EE / 13% ER) and mandatory Tier 2 (5%), voluntary Tier 3
- Student Loan Trust Fund deduction (where employer-mediated)
- End-of-service / redundancy tax treatment
- NHIL / GETFund / COVID levy insofar as they touch payroll (mostly not — noted for accounting pack)
- Monthly PAYE return + SSNIT contribution schedule + Tier 2 schedule
- Annual employee tax certificate + employer annual return
- GRA / SSNIT filing workflows, remittance windows, payment channels
- Statutory identifiers (TIN, SSNIT number, Ghana Card PIN) and their placement in employee/employer records
- Terminology, official document layouts, GL implications, authority contacts

The brief drives the pack — not the other way around.

## Phase 5 — Guided publication, one artifact at a time

Workshop pacing you chose. For **every** artifact we:

1. I explain what it is, why Ghana needs it, where payroll/finance/compliance consume it, and what fails without it.
2. I show you the schema/preview/tokens the publisher will use.
3. You approve.
4. I author it in the platform admin editor as part of the draft Ghana pack.
5. We move to the next artifact.

Publication order (dependency-safe):

```text
Pack metadata + publisher grant + statutory authorities (GRA, SSNIT)
  → Token registry additions (Ghana-specific inputs/outputs)
  → Account role templates + CoA account templates
  → GL mapping keys (per statutory rule: payable + employer expense)
  → Statutory rules
       PAYE (progressive, resident + non-resident branch)
       SSNIT Tier 1 employee, SSNIT Tier 1 employer
       Tier 2 mandatory employer
       Tier 3 voluntary (opt-in via employee input token)
       Bonus tax rule, overtime tax rule
       Student loan trust fund (garnishment-kind + policy)
       End-of-service/redundancy tax treatment
  → Payroll templates (payslip line ordering, deductibility flags,
     pre_tax_deductions[] wiring — validated by the deductibility contract test)
  → Bank export templates (GHS payment file formats for common banks)
  → Remittance schedules (PAYE monthly, SSNIT monthly, Tier 2 monthly)
  → Certificate templates (annual employee tax certificate)
  → Return templates (monthly PAYE return, SSNIT contribution return, Tier 2 return,
     annual employer return) with the 8-state return-run machine wiring
  → Pack requirements (statutory identifiers publishers must collect)
  → Pack health check → 0 conflicts, 0 unresolved tokens, 0 unmapped GL keys
  → Publish v1.0.0 as a draft snapshot for review
  → You review PackDiffView vs the empty baseline
  → Publish → snapshot immutable, tenant upgrade proposals fan out
```

At no point do I install the pack against a tenant unless you explicitly ask; publication ≠ installation.

## Phase 6 — Reference-quality bar

Ghana v1.0.0 must meet the "reference implementation" bar so NG/UG/TZ/ZA can clone the shape:

- Every statutory rule uses `computation_method` + validated `parameters` — zero engine branches.
- Every template renders under `PreviewPanel` with zero `‹unresolved: token›` sentinels.
- Every `pre_tax_deductions[]` code resolves per `pack_income_tax_deductibility_test.sql`.
- Every remittance schedule maps to a real `statutory_authorities` row.
- Every return template has a matching filing-calendar projection.
- `payroll_gl_readiness` returns "fully mapped" for a fresh Ghana tenant fixture.
- No `_kenya`/`paye`/`ssnit`-named SQL functions get added (`no_country_named_functions_test.sql` stays green).
- All schemas registered in `pack_rule_type_schemas` with a `schema_version`.

## Phase 7 — Platform strengthening (only where Ghana exposes it)

Concrete candidates I expect to hit and how I'll handle each:

| Friction I expect | Blocker? | Planned action |
|---|---|---|
| Bonus/overtime tax rules need a `computation_kind` we don't have a schema for | Blocker | Register schema + `SchemaForm` variant, ship with Ghana |
| Non-resident PAYE branch inside a single rule | UX win | Add explicit `parameters.residency_branches[]` to progressive schema |
| Publisher can't see which templates consume a token before renaming | Deferred | ADR 0056 P2.a — I do NOT build the dependency graph now, only document it |
| `PackDiffView` shows raw JSON on the SSNIT rate change | Deferred | ADR 0056 P2.b — semantic diff, not now |
| Tier 3 voluntary contribution needs a registered employee-input token | Blocker | Add to `EMPLOYEE_INPUT_REGISTRY` **and** `pack_token_registry` (kept in sync per the deductibility test) |
| Missing publisher wizard for "add a new country" | UX win | Small onboarding checklist inside `PackEditorShell` — only if scope stays under a day |
| Remittance schedule editor can't express "due 15th of following month, business days" | UX win | Extend `RemittanceSchedulesEditor` schema |

Anything larger goes into an ADR extending 0056 — not into this workshop.

## Deliverables you will see

1. **Engine Map** (chat, with file:line refs)
2. **Business-language platform explainer** (chat)
3. **Publisher Audit** with Blocker / UX-win / Deferred tags (chat, and possibly `docs/audit/2026-07-07-localization-publisher-ghana.md`)
4. **Ghana Compliance Brief** (`docs/localization/ghana/compliance-brief.md`)
5. **Ghana pack v1.0.0 draft**, authored one artifact at a time with your approval
6. **Platform blocker + UX-win fixes** landed alongside Ghana authoring
7. **Deferred-work notes** appended to ADR 0056 (or a new ADR 006x if needed)
8. **Published Ghana pack v1.0.0** with a green PackHealthPanel and a clean PackDiffView

## Technical notes (for reference; skip if you'd rather stay business-first)

- Authoring uses only existing platform-admin editors — no SQL migrations for pack content itself; content lives in `localization_pack_*` and `payroll_statutory_rules` rows written through the editors and validated by `trg_assert_pack_payload_valid` + `validate-localization-payload`.
- Any new `pack_rule_type_schemas` row (bonus tax, non-resident PAYE branch, etc.) is a migration, small and additive.
- Any new registered employee-input token is a two-line change to `EMPLOYEE_INPUT_REGISTRY` in `supabase/functions/compute-payroll/index.ts` **plus** a `pack_token_registry` row — the deductibility test enforces both.
- Publish path: `publish-localization-pack-version` snapshots to `pack_versions`, diffs, and writes `pack_upgrade_proposals`. No tenant is force-upgraded.
- After publish, `process-localization-outbox` fans out `pack.published` events; that is where the audit trail lives.

## What I need from you to start

Nothing else — pacing/scope/aggressiveness are already answered. On approval I begin Phase 1 (read-only) and come back with the Engine Map before touching anything.

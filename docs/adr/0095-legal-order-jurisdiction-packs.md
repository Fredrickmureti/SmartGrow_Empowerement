# ADR 0095 — Legal Order Jurisdiction Packs (Phase 6)

Date: 2026-07-24
Status: Accepted

## Context

ADR-0093 introduced `legal_recipients` as the master-data aggregate.
ADR-0094 sealed the FSM and wired the outbox → finance/ESS subscribers.
Neither addressed the third leg of a real enterprise garnishment
subsystem: **how does the engine know that a Kenyan court order caps
withholding at one-third of gross, while a South-African EAO caps at
25% of remuneration, and a German Lohnpfändung uses the
Pfändungsfreigrenze table?**

The database already carried the infrastructure for this:

- `garnishment_kind_defaults` — one row per kind, `organization_id IS
  NULL` for platform baseline and non-null for tenant override.
- `localization_pack_garnishment_kinds` — pack-scoped rows attached
  to each `localization_packs.id`.
- `garnishment_resolve_kinds(p_org_id)` — SECURITY DEFINER RPC that
  merges the three sources with precedence **tenant > pack >
  platform**.

What was missing was the *data*: platform defaults left
`priority_class` NULL, so the engine sort was non-deterministic; the
Kenya pack seeded a handful of kinds but the industry-standard extras
(alimony, bankruptcy, medical support, sacco/union check-off) had no
platform baseline; and South Africa, Ghana and Germany packs shipped
with zero garnishment rows.

The mature ERPs treat this as strictly pack-driven data:

- **SAP HCM** — country-specific attachment types live in the
  Payroll Country Version.
- **Oracle HCM Fusion** — Involuntary Deduction Types are localized
  per legislative-data-group.
- **Workday** — Involuntary Deduction Types are country-scoped.
- **Dynamics 365 F&O** — Garnishment type table is scoped by
  legislative context.
- **Odoo** — every `l10n_*` module ships its jurisdiction's
  deduction partners and rules.

## Decision

1. **Platform baseline is complete and deterministic.** Every row in
   `garnishment_kind_defaults` where `organization_id IS NULL` carries
   a `priority_class` on the canonical 10 / 20 / 30 / 40 / 50 / 60 /
   99 ladder — child support and equivalents at the top, "other" at
   the bottom. Five additional industry-standard kinds ship at
   platform scope: `alimony`, `medical_support`, `bankruptcy_order`,
   `sacco_loan`, `union_dues`. This is the fall-through that runs
   when a tenant has no pack installed.

2. **Localization packs own jurisdiction specifics.** The Kenya (KE),
   South Africa (ZA), Ghana (GH) and Germany (DE) packs each carry
   at minimum `child_support`, `court_order`, `tax_levy` rows with
   the correct `protected_earnings_rule` for that jurisdiction:

   | Country | Statute                                     | Protected earnings                     |
   | ------- | ------------------------------------------- | -------------------------------------- |
   | KE      | Civil Procedure Act Cap 21, Children Act    | `min_pct_of_gross = 0.3333`            |
   | ZA      | Magistrates' Courts Act §65J, BCEA §34      | `min_pct_of_gross = 0.75`              |
   | GH      | Labour Act 651 §69                          | `min_pct_of_gross = 0.6666`            |
   | DE      | ZPO §850c Pfändungsfreigrenze               | `min_amount` (single-earner 2024 band) |

   New jurisdictions ship by adding a `localization_packs` row plus
   the appropriate `localization_pack_garnishment_kinds` rows — no
   application-code change is required.

3. **Read surface is a security-invoker view.**
   `public.legal_order_effective_kind_defaults` wraps the resolver
   as a queryable relation joined against `organizations`. The
   workspace "Packs" tab, added under `/hr/payroll/legal-orders/packs`,
   consumes this view directly. Because the view is security-invoker,
   tenant callers cannot see other organizations' resolved kinds
   even though the underlying resolver is SECURITY DEFINER.

4. **Tenant overrides remain the escape hatch.** Any org that needs
   a value different from its pack (a locally-negotiated employer
   fee, a jurisdiction the platform does not yet cover) writes into
   `garnishment_kind_defaults` at `organization_id = <tenant>`. That
   row wins over both pack and platform. This is the same three-tier
   pattern used by SAP HCM `V_T5xxx` customization, Oracle Fusion
   legislative-vs-configuration split, and Odoo tenant overrides on
   pack data.

5. **Architecture test guards regression.** The Phase 6 architecture
   test (`legal-orders-phase6-packs.test.ts`) asserts that the
   resolver function is declared, the effective-defaults view is
   security_invoker, the platform hardening UPDATE remains in the
   migration history, and the workspace mounts the Packs tab.

## Consequences

- The engine's priority sort is deterministic without a pack.
- Adding a jurisdiction is a data change, not a code change.
- Operators can see, per organization, which kinds come from the
  platform, from a pack, and from tenant overrides — one screen,
  one source of truth.
- Follow-up work belongs to Phase 7 (remittance cycle closure) and
  Phase 8 (audit + point-in-time reporting). No further Phase 6 work
  is planned.

## References

- ADR-0092 — Garnishment Payable ≠ PAYE Payable.
- ADR-0093 — Legal Recipient master data.
- ADR-0094 — Legal Order Event Integration Contract.
- Migration `20260724..._legal_orders_phase6_jurisdiction_packs.sql`
- View `public.legal_order_effective_kind_defaults`
- Test `src/test/architecture/legal-orders-phase6-packs.test.ts`

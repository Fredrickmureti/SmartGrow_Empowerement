# Payroll GL Readiness — Architecture (2026-05-08)

## Problem this closes
Before this audit, a fresh tenant could install a localization pack (e.g. Kenya),
seed accounts + statutory rules, run payroll for an employee, approve it, and
only at **post-to-GL time** discover that 8–10 mapping keys (`paye_payable`,
`nssf_payable`, `nssf_employer_expense`, `shif_payable`, `ahl_payable`,
`ahl_employer_expense`, `nita_employer_expense`, `salary_expense`,
`net_salary_payable`, …) had no chart-of-accounts mapping. The user saw a
"Cannot post — missing account mappings" wall with no recourse.

## Source-of-truth pieces

| Layer | Object | Purpose |
|---|---|---|
| DB | `payroll_gl_readiness(org, business)` | Returns one row per *required* mapping key (core + per active statutory rule, employee/employer payable + employer expense), with `is_mapped` and a heuristic `suggested_account_id` matched on type + name/code. |
| DB | `payroll_apply_proposed_mappings(org, business, accept[])` | Bulk upsert into `default_account_settings`, then refresh setup status. |
| DB | `payroll_create_and_map_account(org, business, key, name, type)` | Provision a new CoA row + map it in one call. |
| DB | `refresh_payroll_setup_status` | Now lists every unmapped GL key as a blocking reason for the `payroll` app's `app_setup_status`. |
| Edge fn | `install-localization-pack` | After seeding accounts + statutory rules, calls readiness → applies suggestions → creates+maps the rest. Tenants land **fully mapped**. |
| Edge fn | `post-payroll-gl` | Returns structured `{ error: "missing_mappings", missing[], action }` instead of a string toast — kept as a defense-in-depth check. |
| Client | `usePayrollGlReadiness` | Hook over the readiness RPC + bulk/one/create mutations + `dispatchMissingMappings` event bus. |
| Client | `MissingMappingsDialog` (mounted globally in `App.tsx`) | Opens automatically on `payroll:missing-mappings` event with grouped per-row controls + "Apply all suggested". |
| Client | `PayrollGlReadinessBanner` (Overview) | Surfaces the issue at the start of the payroll journey, not at post time. |

## Invariants (do not regress)

1. **Single source of truth.** New mapping logic must go through
   `payroll_apply_proposed_mappings` / `payroll_create_and_map_account`.
   Do not write to `default_account_settings` from anywhere else.
2. **No country hardcoding.** `payroll_gl_readiness` derives required keys from
   `payroll_statutory_rules` for the org. Country-specific rules live in
   localization packs only.
3. **Install-time auto-mapping is mandatory.** Any new statutory rule shipped in
   a localization pack will automatically receive an account at install time
   via the existing pipeline; no per-country code changes required.
4. **Posting must never be the first time the user learns a mapping is missing.**
   Both `refresh_payroll_setup_status` and the Overview banner expose gaps
   *before* a run reaches post.

## AI assistant context-awareness

- `src/lib/ai/routeCatalog.ts` is the only allowlist of paths the assistant may
  link to. Add new safe destinations there.
- `src/lib/ai/actionBlocks.ts` defines the `::action {...}` line protocol;
  validation drops unknown `path_id`s server-side and client-side.
- The chat edge function injects:
  - the catalog,
  - the action-block protocol,
  - a *live* payroll diagnostics block (installed packs, setup status,
    blocking reasons, total/missing GL keys, sample missing labels).
- A virtual Lovable AI Gateway attempt is appended when no provider rows exist
  but `LOVABLE_API_KEY` is configured, so the assistant works on every
  workspace out of the box.

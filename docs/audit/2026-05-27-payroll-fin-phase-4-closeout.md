# Payroll/Finance Hardening — Phase 4 closeout (2026-05-27)

Multi-jurisdiction schema unblock + engine/poster refactor.

## Migration

Single migration. All idempotent and backward-compatible with single-country setups.

| Change | Why |
|--------|-----|
| `DROP INDEX installed_localization_packs_business_unique` | Removed the one-pack-per-business hard cap. |
| `CREATE UNIQUE INDEX installed_localization_packs_business_pack_unique ON (business_id, pack_id) WHERE business_id IS NOT NULL` | New uniqueness key — one row per (business, pack), so a business can install KE + UG + TZ simultaneously. |
| `CREATE UNIQUE INDEX installed_localization_packs_org_pack_unique ON (organization_id, pack_id) WHERE business_id IS NULL` | Same shape for org-wide installs. |
| `ALTER TABLE employees ADD COLUMN statutory_country_code text` + backfill from `business.country` | Per-employee jurisdiction. Empty values inherit business country at resolve time. |
| `idx_employees_statutory_country_code` partial index | Fast filtering for multi-country employee rosters. |
| `resolve_payroll_pack_for_employee(uuid)` SECURITY DEFINER, STABLE | Four-tier fallback: employee country → business pack → org pack → most-recent installed. |
| `resolve_statutory_country_for_employee(uuid)` SECURITY DEFINER, STABLE | Lightweight country-only resolver used by the engine. |

Both functions are `SET search_path = public` (no Function Search Path Mutable warnings introduced).

### Rollback recipe

```sql
-- Restore the one-pack-per-business cap (refuses if any business already
-- has >1 installed pack — that data must be reconciled first).
DROP INDEX IF EXISTS public.installed_localization_packs_business_pack_unique;
DROP INDEX IF EXISTS public.installed_localization_packs_org_pack_unique;
CREATE UNIQUE INDEX installed_localization_packs_business_unique
  ON public.installed_localization_packs (business_id);

ALTER TABLE public.employees DROP COLUMN IF EXISTS statutory_country_code;

DROP FUNCTION IF EXISTS public.resolve_payroll_pack_for_employee(uuid);
DROP FUNCTION IF EXISTS public.resolve_statutory_country_for_employee(uuid);
```

## Engine — `supabase/functions/compute-payroll/index.ts`

- Employee fetch now selects `statutory_country_code, business_id`.
- `bizRow` (business country) is hoisted out of the settings block so the resolver can use it.
- New per-run accumulators `rulesByCountry: Record<country, PayrollRule[]>` and `maxExemptHousingByCountry`.
- Rules loaded in a single query covering every country in the run via `.in("country_code", [...])`.
- Per-employee loop now picks `empRules = rulesByCountry[resolveEmployeeCountry(emp)] ?? statutoryRules` and `empMaxExemptHousing` from the same map.
- Legacy `country_code` payload still works — it's just one of potentially several countries collected from the employee set.

## GL poster — `supabase/functions/post-payroll-gl/index.ts`

- Replaced the "look up the org's installed pack country once" pattern with a `countryByRule` map built from `payroll_statutory_rules` filtered by the `rule_code`s actually in this run's deduction map.
- Per-rule due-date / liability-account / authority-name lookups now use the per-rule country.
- Single-country legacy installs still resolve correctly via the `fallbackCountry` constant.

## Tests

- `src/test/architecture/payroll-multi-jurisdiction.test.ts` — static contract guard. Verifies the engine has `resolveEmployeeCountry`, iterates `empRules`, and the poster uses `countryByRule.get(ruleCode)`.

## Verdict

Phase 4 unblocked. A single payroll run can now mix employees with `statutory_country_code = 'KE'` and `'UG'`, will load both rule sets in one query, apply each employee's correct slice, and post liabilities to the right per-rule country pack. The schema cap that previously blocked a business from installing multiple packs is gone.

Remaining: pack lifecycle (Phase 5) and finance reporting hardening (Phase 6).

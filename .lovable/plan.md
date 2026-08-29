# Smart Grow Empowerment — Microfinance Convergence (living status)

Approved roadmap archive: `.lovable/plan/smart-grow-empowerment-microfinance-system-on-the-accrualflo-2026-08-29.md`

## M1r — Institution bootstrap and admin provisioning (COMPLETE)

Provisioned tenant:
- organization: `db06d986-62c2-47ba-9a1c-f626e09fdc28`
- business: `cbc73525-f93c-4d79-9f9a-8d04e12c4f56` (Smart Grow Empowerment, KE, KES)
- 1 branch, 1 owner profile + owner role, PIN login enabled

Reference data restored by targeted replay (156/193 whitelisted seed statements):
countries 199, default chart templates 79, document kinds 62, format registry 8,
platform apps 19, event topics 152, account role entries 70.

### Platform defects found and fixed (each a scoped migration)
1. `complete_onboarding` had three overloads — dropped the two obsolete
   no-idempotency variants; canonical `text[] + p_idempotency_key` retained.
2. Currency validation resolved against empty org-scoped `currencies` — added the
   global `iso_currencies` catalog, repointed onboarding/provisioning validation,
   and added a trigger seeding the org currency from `businesses.base_currency`.
3. `media_profiles.height_mm` was NOT NULL while continuous receipt profiles seed
   NULL heights — made nullable.
4. Chart-of-accounts provisioning could not run:
   - header templates were inserted as `is_system` without a role → now non-system;
   - header accounts were given a `detail_type` → now NULL for headers, in
     `provision_default_chart_of_accounts`, `upsert_system_account`, and
     `backfill_account_detail_types`;
   - role keys on header templates → roles now resolve to postable leaf accounts;
   - `account_role_eligibility` was missing 26 roles → backfilled from
     `system_account_template`;
   - system-role accounts kept a mis-inferred detail type → backfill now aligns
     them to their template.
   - 11 KE leaf templates had no detail_type → filled.

Result: 101 accounts (18 headers), 41 default account role mappings.
Temporary `__seed_exec` helper removed.

## Next
- M1r verification: Playwright PIN login + app shell smoke test.
- Then M2: dependency analysis before any ERP module removal/adaptation.
  No microfinance domain schema yet; no ERP deletions yet.

## Standing constraints
- One migration at a time; no full historical seed replay (4,842 inserts).
- Exclude POS, payroll, attendance, timesheets, time-off, client portal,
  SaaS/tenant/subscription. Employees remain system actors only.
- Backend-authoritative financial design; business-event driven.
- Security linter reports ~3,785 mostly pre-existing findings; project is not
  security-clean and this must be addressed in a dedicated pass.

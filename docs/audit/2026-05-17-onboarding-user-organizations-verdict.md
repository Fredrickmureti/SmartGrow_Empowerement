# Onboarding failure — `relation public.user_organizations does not exist`

_Verdict date: 2026-05-17. Reporter: `masindecare@gmail.com`._

## TL;DR

New users hit "We couldn't finish setting up your account, relation
`public.user_organizations` does not exist" on `/onboarding-setup`. The
failure is **not** an onboarding-code bug and **not** a missing migration —
it is localized schema drift in two POS trigger functions authored on
2026-05-16 that reference a phantom table name. The canonical membership
table in this project is `public.user_roles`.

## Forensic trace

1. `OnboardingSetup.tsx` → atomic RPC `public.complete_onboarding(...)`.
2. `complete_onboarding` → `seed_pos_business_data(org, business)` →
   `INSERT INTO public.pos_payment_methods (...)`.
3. `pos_payment_methods` carries trigger `zzz_assert_pos_payment_method_scope`
   (attached by migration `20260516115704_...sql`).
4. The trigger function `tg_assert_pos_payment_method_scope()` did:
   ```sql
   SELECT EXISTS (SELECT 1 FROM public.user_organizations uo WHERE ...)
   ```
5. `public.user_organizations` does not exist → Postgres raises
   `42P01` → entire onboarding transaction rolls back → user is stuck
   with confirmed auth identity but no `organizations` / `user_roles`
   rows, and `/onboarding-setup` re-fires the RPC on every visit with the
   same outcome.

## Blast radius (queried live before the fix)

| Surface | Count | Notes |
|---|---|---|
| Functions referencing the phantom table | 2 | `tg_assert_pos_scope_caller_access`, `tg_assert_pos_payment_method_scope` |
| Triggers wired to those functions | 3 | `pos_payment_methods`, `pos_gift_cards`, `pos_discounts` |
| RLS policies | 0 | A coarse ILIKE match suggested 82 — every hit was the helper function `get_user_organizations()`, which itself selects from `user_roles` and is correct. |
| Views | 0 | |
| Application code (`src/`, `supabase/functions/`) | 0 | |

## Fix

`CREATE OR REPLACE` on both trigger functions, rewriting the company-scope
authority predicate to consult `public.user_roles` with `is_active = true`
and the same `role IN ('owner','admin','super_admin')` set. No schema
changes, no data changes, no trigger re-attachment. Branch-scoped writes
continue to go through `user_can_access_branch(...)` unchanged.

## What was NOT changed

- No new `user_organizations` table or compatibility view. Aliasing the
  phantom name would entrench the drift permanently.
- `complete_onboarding`, `seed_pos_business_data`, and the rest of the
  onboarding path are correct and untouched.
- Trigger attachments stay on the same three POS tables with the same
  names.
- No data backfill: stuck users (including the reporter) simply revisit
  `/onboarding-setup`. Because the failed RPC was atomic, no partial rows
  exist to clean up.

## Why "atomic onboarding" surfaced this as a hard wall

`complete_onboarding` is one transaction by design. Any RAISE inside it
(including from a BEFORE trigger on a downstream POS seed) rolls back
org + user_role + business + invitations + POS rows together. That is the
correct behavior — you do not want a half-provisioned tenant. The fix
belongs in the trigger, not in the transaction boundary.

## Canonical naming reminder

The membership table in this project is **`public.user_roles`**
(columns: `user_id`, `organization_id`, `role`, `is_active`, …).
`public.user_organizations` has never existed in the current schema.
Any new SQL referencing org membership must use `user_roles` (or the
helper `public.get_user_organizations(_user_id uuid)` which returns the
org-id set from `user_roles`).

## Verification

- `SELECT to_regclass('public.user_organizations')` → `NULL` (intentional).
- `pg_get_functiondef('public.tg_assert_pos_payment_method_scope'::regproc)
  ~* 'from\s+public\.user_organizations'` → `false`.
- `pg_get_functiondef('public.tg_assert_pos_scope_caller_access'::regproc)
  ~* 'from\s+public\.user_organizations'` → `false`.
- Re-running `/onboarding-setup` for the stuck account completes the RPC
  end-to-end and seeds the four default POS payment methods.
- A non-admin still gets `42501` when attempting to insert a
  company-scoped (`branch_id IS NULL`) `pos_payment_methods` row.
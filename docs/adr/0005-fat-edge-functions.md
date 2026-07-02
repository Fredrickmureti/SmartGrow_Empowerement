# ADR 0005 — Fat Edge Functions to stay under the Supabase 100-function ceiling

**Status:** Accepted  
**Date:** 2026-04-24  
**Context tags:** `infrastructure`, `supabase`, `cost`, `migration-path`

---

## Context

Supabase's free / project-default plan caps deployed Edge Functions at **100**.
We hit this ceiling during the platform-admin / integrations work and had to
delete 8 unused functions to keep building.

We do **not** want to upgrade tiers yet (system is in active development),
but we do want to keep adding capabilities (FX scheduler, SMS test, payment
test, generic provider runner, etc.).

The naive pattern — one function per capability per action — is what blew the
budget:

```
provider-test         provider-run         provider-list
test-bank-connection  test-sms-connection  test-payment-provider
test-platform-payment-provider …
```

Every "test ⇄ run ⇄ schedule" trio for every capability burns 3+ slots.

## Decision

We adopt a **fat edge function** pattern with a clean internal **router**
that dispatches by `capability_key` + `action`.

One function per *family* of operations, not per capability.

### Canonical example: `provider-run`

```
supabase/functions/provider-run/index.ts
├── handles trigger_kind = "manual"            (single, admin-authenticated)
├── handles trigger_kind = "scheduled"         (single, service-role)
└── handles trigger_kind = "scheduled_batch"   (cron entry-point, all due rows)
```

The function inspects the request body, validates auth, and dispatches into
shared handlers in `supabase/functions/_shared/integration-handlers/*.ts`.

Adding a new capability (e.g. `sms`) means:
1. Add `sms.ts` next to `exchangeRates.ts` exporting `{ test, fetch }`.
2. Register it in the `HANDLERS` map.
3. **No new edge function deployed.**

### Future merges

When the function count climbs again, merge in this order (lowest risk first):

| Merge target            | Functions absorbed                                       | Notes                                              |
|-------------------------|----------------------------------------------------------|----------------------------------------------------|
| `provider-test`         | `test-bank-connection`, `test-sms-connection`, `test-payment-provider`, `test-platform-payment-provider` | All four are already capability-keyed. Add `capability_key` to body. |
| `etims-transmit`        | `etims-transmit-invoice`, `etims-transmit-credit-note`, `etims-transmit-pos` | Dispatch on `document_type`.                       |
| `mpesa-callback-router` | `mpesa-callback`, `mpesa-c2b-confirmation`, `mpesa-c2b-validation`, `mpesa-subscription-callback` | Use a `/path` segment as the action key.            |
| `payments-orders`       | `paypal-create-order`, `paypal-capture-order`, `pesapal-create-order`, `pesapal-callback` | Dispatch on `provider` + `action`.                  |

## Rules for fat functions

1. **One file, one Deno.serve.** Keep `index.ts` < 400 lines; push real logic
   into `_shared/`.
2. **Action dispatch must be explicit.** Read `body.action` (or
   `trigger_kind`, `capability_key`, etc.) up-front, validate, then branch.
   No magic string sniffing.
3. **Auth per branch, not per function.** Public webhooks, admin actions,
   and cron entries co-exist in one function only when each branch sets its
   own auth gate at the top of its block.
4. **Document modes in the file header.** The `provider-run` header lists
   all three modes — copy that style.
5. **Migration path is non-negotiable.** Each fat function must be
   refactor-safe: handlers in `_shared/` so we can split later by simply
   creating `provider-run-batch/` that imports the same handler.

## Consequences

✅  We stay well under 100 functions while adding capabilities.  
✅  Cron infrastructure (pg_cron + pg_net) talks to one URL per family.  
✅  Splitting later is a copy-and-trim, not a rewrite.

⚠️  Cold-start cost grows slightly (more imports per function). Acceptable
    while we are in development.  
⚠️  A bug in a fat function affects more flows; mitigation is the
    handler-in-`_shared` rule which keeps blast radius small.

## Related

- `supabase/functions/provider-run/index.ts` — reference implementation.
- `supabase/functions/_shared/integration-handlers/exchangeRates.ts` —
  reference handler module.
- ADR 0004 — Platform Admin vs Tenant boundary (consumes this pattern).
- ADR 0006 — Platform-admin architecture (also consumes this pattern).

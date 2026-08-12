# Currency & FX — verification of prior work, then convergence

## Phase 1 findings (verified against the live database and code, not the log)

Confirmed as claimed:
- `exchange_rates` carries all four provenance columns (`source`, `provider_key`, `published_at`, `created_by`) and holds 13 provider rows.
- `publish_platform_rates()` exists and is scheduled (1 cron job).
- `resolve_exchange_rate` / `require_exchange_rate` / `resolve_fx_realized_account` exist.
- Provider credentials are genuinely locked down: `authenticated` has no SELECT on `credentials` and no UPDATE on the connections table.
- The single client lookup `src/services/fx/rateBook.ts` exists and no rate literal (`129.5`) remains.

Contradicted by evidence — these were logged as done but are not:

1. **"Shared stamper `fx_stamp_document` wired into document triggers" is only half true.**
   Only six tables route through the shared stamper: invoices, sales orders, estimates, credit notes, customer refunds, purchase orders. The AP side — bills, vendor credit notes, purchase returns — each has its **own hand-written stamper**, i.e. exactly the duplicate-engine pattern the brief forbids.

2. **The bill stamper silently falls back to a 1:1 rate.** Its last lines force
   `currency_rate := COALESCE(NULLIF(currency_rate, 0), 1)` and then compute the base total from it. A foreign bill whose rate resolution yields nothing can still post at parity. This is the single highest-severity defect found. It also never re-stamps when only `bill_date` moves.

3. **Step 11 "unrealized revaluation is absent" is wrong — it exists and is defective.**
   `revalue_fx_balances` is implemented and has a UI (`useFxRevaluation`, `FxRevaluationReport`). But it reads `exchange_rates` with a raw query instead of `resolve_exchange_rate`, so it **ignores the override > manual > provider precedence**, and it does `CONTINUE WHEN _new_rate IS NULL` — a missing rate is skipped silently, so a run can report success while leaving foreign balances unrevalued.

4. **A second client rate engine survives.** `useAdminCurrency` still resolves and inverts rates itself off `platform_exchange_rates`. It is scoped to platform billing display and honestly returns null, but it is a second lookup and the guard test does not cover it.

5. **`business_active_currencies` is enforced but never populated.** The expense trigger validates against it, and the table has zero rows across the install, with no UI writing to it. The gate is currently inert and will start rejecting expenses the moment anyone inserts one row.

## Work to do, in dependency order

### Step A — Close the silent-parity hole (critical, first)
Remove the `COALESCE(NULLIF(currency_rate,0),1)` fallback from the bill stamper so a missing rate raises instead of posting at parity, and sweep the other AP stampers plus the settlement engines for the same pattern.

### Step B — Converge the AP stampers onto the shared stamper
Rewrite the bill, vendor-credit-note and purchase-return triggers as thin callers of `fx_stamp_document`, matching the six AR/PO tables: derive currency, validate, resolve strictly, re-stamp on date change, freeze once posted. Delete the duplicated bodies rather than keeping both.

### Step C — Make revaluation use the one resolver
Point `revalue_fx_balances` at `resolve_exchange_rate` so precedence and provenance apply, and turn a missing rate into a recorded, surfaced exception on the run instead of a silent skip. Keep idempotency and closed-period behaviour intact.

### Step D — Step 10, the FX admin surface (the pending item)
Tenant screen showing the rate book with `source` / `provider_key` / `published_at` / effective date per row, an admin override entry that writes `source = 'override'` with a reason through a server-validated RPC, and a currency-enablement UI that finally seeds `business_active_currencies` (defaulting to the base currency so the expense gate can never lock a tenant out).

### Step E — Ratchets
Extend the architecture guards to fail on: a re-introduced `COALESCE(... , 1)` rate fallback in any stamper, an AP stamper not delegating to `fx_stamp_document`, a rate lookup outside `rateBook` (including `useAdminCurrency`), and a revaluation path reading `exchange_rates` directly.

### Step F — Carry-over
Approval-gated reversal for `vendor_credit_note`, unrelated to FX, last.

## Technical notes
- All rate resolution stays server-side; the client keeps display-only `rateBook`.
- No new tables, no new resolver, no compatibility fallbacks — the duplicated AP stampers get deleted, not wrapped.
- The plan log will be rewritten to state verified status rather than claimed status, and ADR 0136 gets a note that the AP stampers were non-conforming until Step B.

# ADR 0009 — POS Payment State Model

Status: Accepted · 2026-05-13

## Context

The POS originally modelled a payment row with two fields: `method` and
`amount`. A 19,000 cash sale where the customer tendered 20,000 was stored
as `amount = 19000`, with no record of the 20,000 presented or the 1,000
returned. The receipt then printed "Tendered 19,000 / Change 0", which is
wrong and unauditable.

The split-payment UI also surfaced every method whose `is_enabled` flag was
true, regardless of whether the underlying provider, terminal, or clearing
account was actually configured. Cashiers could pick "M-Pesa" or "Card" on
a register that had no working integration behind them.

## Decision

### Four-axis payment row

Every payment row carries four orthogonal values:

| field             | meaning                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `amount`          | Value applied to the invoice. Sum across rows == invoice total. |
| `tendered_amount` | What the customer presented. `>= amount` for cash; `== amount` otherwise. |
| `change_given`    | Returned to the customer. Cash only; non-cash is always `0`.    |
| `reference`       | Provider receipt / cheque number / external transaction id.     |

Invariants enforced end-to-end (PaymentDialog → POSTerminal → RPC →
`pos_transaction_payments`):

- `tendered_amount >= amount` (cash overtender allowed; under-tender rejected).
- `change_given = max(0, tendered_amount - amount)` for cash.
- `change_given = 0` for every non-cash method.
- `sum(amount across rows) = grand_total` (split payments balance to the cart).

### Resolver as the single source of truth

`src/lib/pos/paymentMethodResolver.ts` exports `resolvePaymentMethods`,
which takes the raw `pos_payment_methods` rows plus contextual inputs
(register allow-list, active provider configs, customer presence,
terminal-device presence) and returns a `ResolvedPaymentMethod[]` with
`{ isReady, blockedReason, blockedMessage }` per method.

Dialogs MUST consume the resolver's output; they MUST NOT filter
`pos_payment_methods.is_enabled` directly. Unready methods are still
returned so the UI can render them as disabled chips with a clear reason
and a link to the relevant Settings page.

Readiness matrix:

| method          | gate                                                             |
| --------------- | ---------------------------------------------------------------- |
| `cash`          | always ready                                                     |
| `credit`        | customer must be selected on the cart                            |
| `mobile_money`  | active provider (`mpesa`/`flutterwave`/`paystack`) AND clearing account |
| `card`          | online gateway OR registered terminal device, AND clearing account |
| `bank_transfer` | clearing account when `requires_reference` is true               |
| `voucher`       | clearing account when `requires_reference` is true               |

### One `finalize_table_order` overload

Postgres resolves function overloads by argument count. The legacy 3-arg
`finalize_table_order(uuid, jsonb, numeric)` did not persist
`tendered_amount` / `change_given`, and any caller that omitted
`p_created_by` would land on it and silently drop tender data. We dropped
the 3-arg overload in migration `20260513…drop_legacy_finalize_table_order`.
The 4-arg version (with `p_created_by`) is now the only overload and is
the single source of truth for table-order finalization.

## Consequences

- Receipts, Z-reports, and reconciliation views always have real tender and
  change data.
- Adding a new payment method or provider requires extending the resolver's
  matrix in one place, not chasing flags across dialogs.
- The architecture-guard test
  `src/test/architecture/pos-terminal-payment-mapping.test.ts` fails the
  build if a future edit re-introduces the `{ method, amount, reference }`
  shape that originally caused the bug.
- The resolver matrix is locked by
  `src/test/pos/payment-method-resolver.test.ts`.
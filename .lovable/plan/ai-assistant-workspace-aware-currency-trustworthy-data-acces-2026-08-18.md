# AI Assistant: Workspace-Aware Currency + Trustworthy Data Access

## What is actually broken (verified)

The assistant's currency rule is built from a column that does not exist.

- `supabase/functions/ai-assistant/index.ts` line 297 selects `name, base_currency, email, phone, address, city, country` from `organizations`.
- The `organizations` table has **no `base_currency` column** (verified against the live schema). That select fails, `organization` comes back null, and line 664 falls through to `const cur = organization?.base_currency || 'USD'`.
- So every chat is told "This workspace's base currency is **USD**", and the model dutifully prints USD everywhere.
- The real currency lives on `businesses.base_currency` — the only business in this workspace is `Joshua Holdings`, currency **KES**, country **KE**. The rest of the platform already reads it that way (`useViewCurrencyPreference`, `useTenantFx`, `generate-document`, `generate-annual-earnings-statement`).

Two more gaps found while tracing it:

1. Only `chat`, `financial_insights` and `suggest_actions` get any currency context at all. `categorize_expense`, `analyze_invoice`, `email_assist`, `document_text` and `match_transactions` are sent to the model with **no currency instruction whatsoever** — they default to USD by model habit.
2. Foreign-currency records are flattened. Bank accounts carry a per-account `currency`, invoices/bills carry document currency, but every number is formatted with a single workspace code, so a USD bank account in a KES workspace is reported as "KES <amount>". The assistant is confidently wrong, not just cosmetically wrong.

## The fix

### 1. One server-side currency resolver (root cause)

Add a single `resolveWorkspaceCurrency()` seam in the edge function that mirrors the frontend precedence and never guesses:

```text
selected business.base_currency
  -> if no business selected: the org's businesses' base_currency when they all agree
  -> if they disagree: "MIXED" (report each business/document in its own currency)
  -> if genuinely unknown: no currency claim at all + a prompt line telling the
     assistant to say the workspace currency is not configured and link
     Localization Settings, instead of inventing USD
```

`'USD'` disappears as a literal default from the assistant — including `formatCurrency`, which will require an explicit code from its caller.

### 2. Currency context on every request type, not just chat

The resolved currency (plus country and the workspace's active currencies from `business_active_currencies`) becomes a small header block prepended to **all** request types, so expense categorisation, invoice analysis, email drafting and document text all speak the workspace's money.

### 3. Stop flattening per-record currency

Where a record carries its own currency (bank accounts, invoices, bills, POS, landed costs), format with **that** code and mark it as foreign, e.g. `USD 1,200.00 (foreign — base KES)`. Totals stay in base and are labelled as base-currency conversions. Where a real converted total cannot be resolved, say so rather than summing mixed currencies.

### 4. Make it trustworthy: tools instead of a frozen snapshot

Today the assistant gets one giant hand-curated snapshot (~20 hardcoded queries, `limit 50`), so anything outside those queries it answers from imagination. Replace that with model tool-calling over the caller's own session (RLS-enforced — the assistant can never see more than the user):

- `query_data` — read-only, whitelisted-table structured reads (table, columns, filters, order, limit) executed with the caller's JWT so RLS scopes every row; parameterised, no raw SQL from the model.
- `describe_schema` — lets the model discover available tables/columns instead of guessing field names.
- `get_currency_context` — base currency, active currencies, and live rates via the existing `describe_exchange_rate` seam, so FX answers match the Banking/Landed Cost panels.
- `run_operation` — a small, explicit allowlist of write RPCs, each requiring a user confirmation step in the UI before it executes. Nothing is written silently.

The snapshot shrinks to a lightweight orientation summary; depth comes from tools. Every tool call is logged to `ai_usage_logs` so answers are auditable.

### 5. Ratchets so it cannot regress

Vitest architecture tests plus a Deno test on the function:

- no `|| 'USD'` / `"USD"` literal fallback anywhere in `ai-assistant`;
- no code reads `organizations.base_currency` (the column does not exist);
- every request type receives a currency context block;
- `formatCurrency` cannot be called without an explicit currency code.

## Technical notes

- Files: `supabase/functions/ai-assistant/index.ts` (resolver, context builder, tool loop), a new `supabase/functions/_shared/workspaceCurrency.ts`, `src/hooks/useAIAssistant.ts` (tool-call round trips + confirmation prompts for `run_operation`), and the assistant chat UI for confirmation cards.
- No schema migration is needed for the currency fix — the data is already correct on `businesses`; the function is reading the wrong place.
- `query_data` will use a per-request client built from the caller's `Authorization` header, never the service role, so the tool surface inherits existing RLS. The write allowlist starts small (draft creation, status changes already exposed as RPCs) and grows only on request.

## Suggested sequencing

1. Currency resolver + all-request-type context + ratchet tests (fixes the reported bug on its own).
2. Per-record currency fidelity and FX-aware totals.
3. Read tools (`describe_schema`, `query_data`, `get_currency_context`) replacing the frozen snapshot.
4. Confirmed write operations (`run_operation`).

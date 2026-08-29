# Microfinance convergence — migration status

## M0. Stack repair — DONE

- `src/server.ts`, `src/start.ts`, `src/lib/error-page.ts`, `src/lib/error-capture.ts` in place.
- `vite.config.ts` uses `@lovable.dev/vite-tanstack-config` with `tanstackStart.server.entry = "server"`.
- Tailwind upgraded to v4 (`tailwindcss`, `@tailwindcss/vite`); `src/index.css` now uses
  `@import "tailwindcss"` + `@config "../tailwind.config.ts"` so the existing v3 theme and
  `@layer`/`@apply` rules keep working unchanged.
- `createCsrfMiddleware` is not exported by the pinned `@tanstack/react-start`; `src/start.ts`
  registers only `errorMiddleware` and carries a note to re-add CSRF after a dependency bump.
- Gate: `GET /` returns 200 and SSR renders the document; build log reports `build OK`.

## M1. Environment isolation — DONE

See `docs/microfinance/isolation-check.md`. `supabase/config.toml` pinned to
`xwxqunklduknceoryrha`; all hardcoded `jkszmrroyjfdwokbkzis` references removed from `src/`.

## M2. Dangling-import purge — DONE

Gate: a repo-wide import resolver reports 0 unresolved local imports; `tsgo --noEmit` is clean.

Removed (ERP domains out of scope): sales/purchase document pages (invoices, bills, credit notes,
proforma, recurring, vendor statements, customer payments, expenses), document line rows for those
documents, product/inventory/POS/scanner/warehouse/etims/hardware/checkout component trees, offline
POS sync services, and the corresponding test suites.

Rebuilt or re-pointed instead of deleted (kept surfaces that depended on removed leaves):

- `src/components/finance/AccountSelectField.tsx` — replaces the product-module account selector
  used by contact forms; wraps the existing `AccountCombobox`.
- `src/components/checkout/PaymentMethodSelector.tsx` — subscription checkout picker for
  `pages/Upgrade.tsx`.
- `ResolvedPrintPolicyPanel` now owns its `ResolvedPrintPolicy` type locally.
- `AppSidebar` no longer depends on POS settings (nav IA rework belongs to M6).
- AP/AR pages keep their aging/analysis surfaces; bill/invoice payment dialogs were removed with
  the purchasing/sales domains and are pending replacement by the microfinance payment flows.

## Next

M3. RBAC + PIN completion (requires a database migration), then M4–M6 settings baseline, company
convergence and the microfinance workspace scaffold.

## M2. Inherited SQL history replayed — DONE (2026-08-29)

Root cause of the "hollow database": of the 2,893 files in `supabase/migrations`, only the 11
authored on 2026-08-29 had ever been applied to `xwxqunklduknceoryrha`. The other 2,882
(AccrualFlow foundation) existed as files only.

All 2,882 were replayed in chronological order, statement by statement, skipping
already-existing objects. Three passes plus a column backfill (the Aug-29 baseline had created
narrower versions of `organizations`, `journal_entries`, `exchange_rates`, `bills`, `contacts`,
`document_*`, so inherited ALTERs had nothing to attach to; 197 columns restored from the
original DDL).

Result: **842 tables, 126 views, 3,085 functions, 2,072 policies** — 874 of the 948 objects the
history defines. The 74 still missing are POS, payroll, spreadsheet, e-signature and RFQ/sourcing
leftovers, i.e. outside the universal foundation.

Known follow-ups (not blocking): Supabase linter inherits AccrualFlow's posture — 1 table without
RLS, 29 SECURITY DEFINER views, an auth.users-exposing view. Harden before go-live.

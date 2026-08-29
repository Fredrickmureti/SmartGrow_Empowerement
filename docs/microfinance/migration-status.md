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

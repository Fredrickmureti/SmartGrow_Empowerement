# Project Memory

## Core
Keep Supabase migrations small and single-purpose (one function/object each) — large multi-object migrations have destabilised this database. Never batch.
FX: one rate book, one resolver (`resolve_exchange_rate`/`require_exchange_rate`), no `COALESCE(rate, 1)` anywhere; a missing rate is an absence, never 1:1.
Authoritative project status lives in `.lovable/plan.md` — update it after every implementation step.

## Memories
- [Currency & FX](mem://features/currency-and-fx-resolution) — ADR 0135/0136/0138: rate book, precedence, server-only booking rates, revaluation and exposure engines
- [Contact identity vocabulary](mem://constraints/contact-identity-vocabulary)
- [Profiles lookup key](mem://constraints/profiles-lookup-key)

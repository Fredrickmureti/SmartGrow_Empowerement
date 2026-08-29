# Environment isolation check (Migration M1)

Date: 2026-08-29

## Target project (the only SQL target)

| Item | Value |
| --- | --- |
| Supabase project ref | `xwxqunklduknceoryrha` |
| Supabase URL | `https://xwxqunklduknceoryrha.supabase.co` |
| `supabase/config.toml` `project_id` | `xwxqunklduknceoryrha` (was `jkszmrroyjfdwokbkzis`) |
| `.env` server vars | `SUPABASE_URL`, `SUPABASE_PROJECT_ID`, `SUPABASE_PUBLISHABLE_KEY` — all on `xwxqunklduknceoryrha` |
| `.env` client vars | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PUBLISHABLE_KEY` — all on `xwxqunklduknceoryrha` |

## Reference project (never written to)

AccrualFlow: `jkszmrroyjfdwokbkzis`. Its SQL under `supabase/migrations/` is treated as
read-only reference text. No credentials for it exist in this project.

## Hardcoded references removed

`grep -rn "jkszmrroyjfdwokbkzis" src supabase/config.toml` now returns 0 hits. Previously:

- `supabase/config.toml` — project pin
- `src/hooks/useAIAssistant.ts` — hardcoded URL fallback (live runtime risk)
- `src/hooks/usePaymentProviders.ts` — hardcoded callback URL (live runtime risk)
- `src/components/admin/AuthEmailTemplates.tsx` — dashboard deep link
- `src/test/mocks/handlers.ts`, `src/test/mocks/handlers/pos.handlers.ts`,
  `src/test/architecture/certificate-templates-canonical-binding.test.ts` — test fixtures

## Storage

Buckets are created only through the project's storage tooling against
`xwxqunklduknceoryrha`. No bucket names are shared with the reference project's data.

## Verification

- `curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/` → `200`
- `grep` sweep above → 0 residual references

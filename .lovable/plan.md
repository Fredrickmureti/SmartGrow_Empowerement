# Consolidate AccrualFlow Edge functions into one router

## Why
The project is at Supabase's Edge Function ceiling (`SUPABASE_MAX_FUNCTIONS_REACHED`). The six agent/workstation functions have never deployed, so enrolment 404s. Folding them into one router removes 5 slots of pressure and lets enrolment ship without a plan upgrade or churning the 100 unrelated functions.

## Target shape

One deployed function, `edge`, that dispatches on the trailing path segment:

```text
POST /functions/v1/edge/workstation/register        (was edge-workstation-register)
POST /functions/v1/edge/workstation/rotate-secret   (was edge-workstation-rotate-secret)
POST /functions/v1/edge/workstation/manifest        (was edge-workstation-manifest)
GET  /functions/v1/edge/workstation/origins         (was edge-workstation-origins)
POST /functions/v1/edge/agent/poll                  (was edge-agent-poll)
POST /functions/v1/edge/agent/complete              (was edge-agent-complete)
```

Each old `index.ts` handler body becomes a route module imported by `supabase/functions/edge/index.ts`. Auth model, request/response shapes, CORS behaviour, and DB access stay byte-identical — this is a transport rename, not a redesign.

## Changes

### 1. New router function
- Create `supabase/functions/edge/index.ts`. It:
  - Handles `OPTIONS` with the shared `corsHeaders`.
  - Parses `new URL(req.url).pathname`, strips the `/edge` prefix, matches against a small route table.
  - Delegates to `./routes/workstation-register.ts`, `workstation-rotate-secret.ts`, `workstation-manifest.ts`, `workstation-origins.ts`, `agent-poll.ts`, `agent-complete.ts`.
  - Returns `404 { code: "NOT_FOUND" }` for unknown subpaths and `405` for wrong methods.
- Move each existing handler's logic into its route module (one export: `handle(req: Request): Promise<Response>`). No behaviour change.

### 2. Delete the six old function folders
Remove `supabase/functions/edge-workstation-register`, `edge-workstation-rotate-secret`, `edge-workstation-manifest`, `edge-workstation-origins`, `edge-agent-poll`, `edge-agent-complete`. They're undeployed, so nothing breaks; keeping them invites drift.

### 3. Update desktop callers (`packages/desktop/src/pages/`)
Both currently use `supabase.functions.invoke('edge-workstation-…')`. That helper hits `/functions/v1/<name>` and can't reach a subpath. Switch these two to a direct `fetch` against `${SUPABASE_URL}/functions/v1/edge/workstation/<action>` with the same headers `functions.invoke` was setting (`apikey`, `Authorization: Bearer <session token>`, `Content-Type: application/json`). Preserve current error handling and returned shape.

- `Onboarding.tsx` → `POST /edge/workstation/register`
- `Auth.tsx` → `POST /edge/workstation/rotate-secret`

### 4. Update agent callers (`agent/src/`)
Already use raw `fetch(`${cfg.supabase_url}/functions/v1/edge-…`)`. Rewrite the URLs only:

- `manifest.ts` → `/functions/v1/edge/workstation/manifest`
- `origins.ts` → `/functions/v1/edge/workstation/origins`
- `relay.ts` → `/functions/v1/edge/agent/poll` and `/functions/v1/edge/agent/complete`
- `index.ts` + `server.ts` + `README.md`: update log strings/comments to the new paths.

### 5. Docs / migration comment
- `packages/desktop/README.md` and `agent/README.md`: replace old function names with new paths in the endpoint tables.
- `supabase/migrations/20260726025651_*.sql` contains only comments referencing the old names — update those comments in a new migration (or leave; comments don't affect runtime). Recommend: leave the historical migration untouched; add nothing new.

### 6. Deploy
After the edits, deploy just `edge`. That's a net **+1** function; the six deletes free 6 slots when the old ones eventually get cleaned up (they aren't deployed today, so no immediate slot pressure). Enrolment, rotate, manifest, origins, poll, complete all become reachable.

## Out of scope
- No changes to auth model, DB schema, RLS, or payload shapes.
- No audit of the other ~95 functions for cleanup (can be a follow-up if slot pressure returns).
- No production URL / CORS / HTTPS-loopback work — that's the parent Edge architecture initiative, unaffected by this consolidation.

## Verification after build-mode switch
1. `supabase functions deploy edge` succeeds.
2. `curl -sS -X POST $URL/functions/v1/edge/workstation/register …` returns the same JSON as the old function did in local dev (401 without auth, 200 with).
3. Rebuild the Electron desktop app; enrolment completes without a 404.
4. Agent logs on next start show manifest publish + origins refresh hitting the new paths with 200.

# Resilience Contract

This document describes how the ERP detects connectivity loss, normalizes
failures, and keeps the UI honest under degraded networks. New hooks and
modules MUST follow this contract.

## TL;DR

```ts
import { safeQuery, normalizeError, connectivityManager } from "@/services/resilience";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

const { data, error } = await safeQuery(
  supabase.from("invoices").select("*").eq("organization_id", orgId)
);

if (error) {
  // `error` is a NormalizedError — never raw `error.message`.
  toast.error(error.title, { description: error.message });
  return;
}
```

For retryable operations:

```ts
import { safeQueryRetry } from "@/services/resilience";

const { data, error } = await safeQueryRetry(
  () => supabase.from("payslips").select("*").eq("run_id", runId),
  { maxRetries: 2 }
);
```

## State machine

| State      | Meaning                                                        | UI affordance                     |
| ---------- | -------------------------------------------------------------- | --------------------------------- |
| `online`   | navigator + Electron + recent probe all agree we're reachable. | No banner.                        |
| `degraded` | navigator says online but a recent request failed at transport | Amber "Connection unstable" strip |
| `offline`  | navigator offline OR Electron OS-level offline                 | Red "You're offline since HH:MM"  |

A separate `realtime` sub-state surfaces "Live updates paused — reconnecting…"
after a 5s grace window when channels report `channel_error` or `timed_out`.

## Error vocabulary (closed set)

`NormalizedError.kind` is one of:
`offline | timeout | auth_expired | auth_invalid | permission_denied | not_found | server_unavailable | conflict | validation | unknown`.

UI never branches on raw `error.message`. Add new kinds in
`ErrorNormalizer.ts`, never inline.

## Global coordination

- **AuthExpiryCoordinator** — any `auth_expired` anywhere in the app fires
  exactly one toast + one local sign-out + one redirect to
  `/login?reason=session_expired&redirect=<href>` within a 30s suppression
  window. Wired via `<AuthExpiryBridge />` in `App.tsx`.
- **ConnectivityBanner** — single global affordance. Three modes (offline,
  degraded, realtime-degraded). No per-feature reconnection toasts.

## Rules

1. **Never** render `error.message` to a user. The `local/no-raw-error-message-in-toast`
   ESLint rule enforces this.
2. **Never** branch on `navigator.onLine` directly — use `connectivityManager.getStatus()`
   or `useConnectivity()`.
3. **Always** wrap Supabase calls in `safeQuery` / `safeRpc` when the result
   is user-facing. This drives the state machine.
4. **Retries** use `safeQueryRetry` — never hand-rolled `for` loops. Only
   `offline`, `timeout`, and `server_unavailable` retry; auth/permission
   failures are deterministic.
5. **Timeouts** default to 15s. Override per-call with `{ timeoutMs }` when
   the operation legitimately takes longer (bulk reports, large imports).

## Adoption status (2026-05-19)

- Resilience layer: shipped end-to-end (timeout, retry, lastOnlineAt,
  preload-race fix).
- 25/25 resilience tests passing.
- Per-hook adoption: incremental. New hooks MUST adopt. Legacy hooks are
  migrated module-by-module; the ESLint rule is at `warn` and will escalate
  to `error` once the sweep completes.

---

## Workspace install-state hydration (Phase 7 parity)

The Electron renderer and the browser/PWA use the same React tree, the same
`useWorkspaceContextReady` predicate, and the same `InstalledAppsHydration`
side effects. Critical invariants:

- The Electron main process MUST NOT publish a "ready" handshake that
  bypasses `useWorkspaceContextReady`. The renderer is the sole authority
  on whether an app is installed for the current org.
- Offline behaviour: when `ConnectivityManager` reports offline AND
  `useInstalledApps` has a fresh (<24h) same-org cache,
  `useWorkspaceContextReady` returns `{ ready: true, reason: "offline_cached" }`
  so the workspace mounts optimistically. Without a fresh cache it returns
  `{ ready: false, reason: "offline_unverified" }` and install-aware
  surfaces render the branded loader — never the activate page.
- The `installed-apps-cache-v2-<orgId>` localStorage envelope is the only
  client-side persistence of install state. See
  `docs/architecture/PWA_HYDRATION.md` for the service-worker policy.

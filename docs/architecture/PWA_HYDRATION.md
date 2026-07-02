# PWA & service-worker hydration policy

## Install-state hydration

The workspace install state (`organization_installed_apps`) is the single
source that decides whether a user sees the workspace or the "Install / Activate"
landing page. To avoid the symptom class "already-installed app appears
uninstalled", the service worker (if/when one ships) MUST follow these rules:

1. **Never** cache authenticated responses for the `organization_installed_apps`
   table or any RPC that mutates it (`install_app`, `uninstall_app`,
   `update_app_last_accessed`). A stale cached response will paint the
   activate page for a tenant who has the app installed.
2. The per-org localStorage cache used by `useInstalledApps`
   (`installed-apps-cache-v2-<orgId>`) is the only place install state is
   persisted client-side. It is gated by a 24h TTL and a same-org check.
3. On sign-out, `InstalledAppsHydration` invalidates the React Query key
   `["installed-apps", orgId]`; any custom persister (IndexedDB / SW cache)
   must purge entries for that key too.
4. Offline first-paint is allowed only when a fresh same-org cache exists.
   `useWorkspaceContextReady` reports `reason: "offline_cached"` in that
   case; without a fresh cache it reports `reason: "offline_unverified"`
   and gates show a loader, NEVER the activate page.

## Electron parity

The Electron renderer uses the same React tree, the same
`useWorkspaceContextReady` predicate, and the same `InstalledAppsHydration`
side effects. The Electron main process MUST NOT shortcut install state
(no "main-process said go" handshake that bypasses the gate). See
`docs/architecture/RESILIENCE.md`.

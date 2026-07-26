# AccrualFlow Edge Desktop

The tray-based operator console that owns a single workstation's identity, monitors the AccrualFlow Edge runtime, and exposes device inventory + diagnostics — implementation of plan §5 Phase 4.

## Layout

```
packages/desktop/
├── electron/
│   ├── main.cjs          # Main process — window, tray, IPC surface, agent supervisor
│   └── preload.cjs       # Context-isolated IPC bridge exposed as `window.edge`
├── src/
│   ├── main.tsx          # React entry
│   ├── App.tsx           # Router: Onboarding wizard vs tabbed console
│   ├── components/       # Sidebar, shared UI
│   ├── lib/              # Zero-dep Supabase client + config
│   ├── pages/            # Onboarding, Dashboard, Devices, Diagnostics, Logs, Auth
│   ├── styles.css        # Dark operator-console theme
│   └── types.d.ts        # `window.edge` typings
├── index.html
├── vite.config.ts        # base: './' — REQUIRED for Electron file:// loading
├── tsconfig.json
└── package.json
```

## Design principles

- **Renderer is sandboxed.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The only surface it can reach is `window.edge.*` defined in `preload.cjs`.
- **Durable credential lives on disk, not localStorage.** The workstation secret is written to `~/.accrualflow/edge/workstation.json` at mode 0600 by the main process. The renderer never sees the raw secret after the enrolment moment.
- **Supabase session is in-memory only.** We sign in with the operator's email/password just long enough to invoke `edge/workstation/register` / `edge/workstation/rotate-secret`; the durable credential is the workstation secret, not the user's session.
- **Zero-dependency Supabase client** (`src/lib/supabase.ts`). We call PostgREST + edge functions with `fetch`. Keeps the packaged installer lean and avoids pinning to a specific `@supabase/supabase-js` major.
- **Tray-first.** Closing the window keeps the app alive in the tray. The child agent runtime is supervised by the main process and stopped on `before-quit`.

## Develop

```bash
cd packages/desktop
npm install
npm run dev            # Vite dev server on :5180
EDGE_DESKTOP_DEV_URL=http://localhost:5180 npm start   # Electron loads the dev URL
```

`npm start` runs `scripts/build-agent.mjs` first, which installs the agent's
dependencies (with `usb` as an *optional* native dep) and compiles
`agent/dist/index.js`. The main process auto-starts that runtime on launch,
waits for `/health`, supervises it with backoff restarts, and streams its
stdout/stderr into the Logs tab. Set `agent_autostart: false` in the desktop
settings file to opt out, or `ACCRUALFLOW_AGENT_ROOT` to point at another
runtime checkout.

### Packaging notes

`package:*` and `package:signed` pass `--extra-resource=../../agent`, so the
runtime and `scripts/install-service.cjs` land in `resources/agent` inside the
app. Without that, the tray app reports `agent_not_bundled` /
`installer_not_bundled`.

### Update channel

No channel URL is hardcoded. Set `EDGE_UPDATE_URL`
(`https://…/{channel}.json`) or the `update_channel_url` desktop setting.
With none configured the Updates panel reports "Update channel not
configured" instead of a failed check.

Build the renderer + launch Electron against the static bundle:

```bash
npm run build && npm start
```

## Package

Uses `@electron/packager` — `electron-builder` is not usable in the Lovable sandbox (7-zip dynamic linking failure — see `<electron-desktop-app>` in platform knowledge).

```bash
npm run package:linux   # → release/AccrualFlowEdge-linux-x64/
npm run package:win     # cross-compiles from Linux (no code signing here)
npm run package:mac     # cross-compiles; a real release requires notarization on macOS
```

## Phase-4 status

Shipped in this commit:

- Enrolment wizard end-to-end (sign-in → org pick → name → `edge/workstation/register` → 0600 file write → agent auto-start).
- Dashboard with agent supervisor + relay-heartbeat freshness pill.
- Devices tab reading `public.workstation_devices` live.
- Diagnostics self-test scaffold.
- Logs viewer against agent `/support-bundle` ring buffer.
- Auth tab: rotate credential (`edge/workstation/rotate-secret`), sign-out workstation.

Deferred to Phase 4.2 (documented as such inside Diagnostics):

- Local TLS on the loopback listener.
- SSE tail for live log streaming.
- Realtime subscription for the devices/dashboard panels (currently 10-15s poll).
- Real device probes (test page, drawer kick, scale read).
- Signed installers with EV certs, notarization, and auto-update channel.

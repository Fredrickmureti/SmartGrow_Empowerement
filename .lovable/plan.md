## Diagnosis

I unzipped `production.zip` into `/tmp/prod` and hashed every plausibly-relevant file against the current tree. **`package.json` is byte-identical** — no dependency drift, no reinstall needed. Only **four files** diverged from production, and together they explain the "bare shell / unstyled / hydration" symptom class:

| File | What dev did | Effect |
|---|---|---|
| `vite.config.ts` | Added the `@tanstack/react-start/plugin/vite` `tanstackStart({...})` plugin | Converts the pure Vite SPA into a TanStack Start SSR app. `src/App.tsx` (BrowserRouter, Sentry, Supabase, 200+ pages) was never designed to SSR — every request now goes through `src/server.ts` and serves a shell that the client has to re-mount. This is the root cause. |
| `src/main.tsx` | Added `import "./design-system/tokens.css"` alongside `./index.css` | Compensation for the next change. Harmless once vite.config is reverted, but unnecessary. |
| `src/index.css` | Removed the `@import "./design-system/tokens.css"` line | Broke the single-CSS-entry contract prod relies on. |
| `src/routes/__root.tsx` | Added `import "../design-system/tokens.css"; import "../index.css";` and swapped the component wiring | Only relevant while TanStack Start is the entry — becomes dead code once the SPA is restored, but must match prod so the file doesn't regress if TanStack is ever re-enabled. |

Everything else — `App.tsx`, `router.tsx`, `server.ts`, `tailwind.config.ts`, `postcss.config.js`, `tsconfig*.json`, `index.html`, `package.json`, all of `src/apps/*`, `src/features/*`, `src/components/*`, `supabase/functions/*`, `src/routeTree.gen.ts`, the newer Inventory/Payroll/Settings/HR work — is byte-identical to prod or brand-new (untouched by this restore).

The 4 files above are the entire divergence. No feature code is affected.

## Plan

1. **Restore `vite.config.ts`** from `/tmp/prod/vite.config.ts` — removes the `tanstackStart()` plugin and its `@tanstack/react-start/plugin/vite` import. The config becomes: `react()` + `componentTagger()` (dev only) + `VitePWA()`, exactly like prod. `index.html` (already identical) will mount `/src/main.tsx` directly.
2. **Restore `src/main.tsx`** from prod — a single `import "./index.css"` before `initSentry()` and `createRoot(...).render(<App />)`.
3. **Restore `src/index.css`** from prod — re-adds the `@import "./design-system/tokens.css"` after the `@tailwind` directives so tokens ship with the one global stylesheet.
4. **Restore `src/routes/__root.tsx`** from prod — brings back the `(Route as any).options.component = () => <Outlet />` hack and drops the double CSS imports. This file becomes inert once TanStack Start is unplugged; restoring it keeps parity in case the Lovable sandbox ever re-enables the SSR entry.
5. **Leave everything else alone.** No package installs (lockfile + package.json already match prod), no touches to `src/App.tsx`, `src/router.tsx`, `src/server.ts`, feature directories, supabase functions, or `src/routeTree.gen.ts`.
6. **Verify**: after restart, `curl -s http://localhost:8080/` should return `index.html` verbatim (not a TanStack SSR shell), and the browser should render `<App />` with full Tailwind + tokens applied.

## Rollback

All four target files are exactly `/tmp/prod/<path>`; if the SPA restore surfaces any newer expectation, we can re-apply the current `vite.config.ts` in isolation without touching anything else.

## Files changed

- `vite.config.ts`
- `src/main.tsx`
- `src/index.css`
- `src/routes/__root.tsx`

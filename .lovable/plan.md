## Incident summary

The app renders as bare HTML with no Tailwind/theme styling and React reports "hydration failed / server HTML replaced with client content". These are **downstream symptoms**. The CSS pipeline, Tailwind config, `index.css`, `tokens.css`, `__root.tsx`, providers, and `App.tsx` are all healthy.

## True root cause (proven, not guessed)

Every request to the dev server currently returns **HTTP 500** with this SSR error in the Vite daemon log:

```
Error: Cannot find module '#tanstack-start-entry'
  imported from '@tanstack/start-server-core/dist/esm/createStartHandler.js'
  at loadEntries (createStartHandler.ts:115)
  at plugin.js:79 (@tanstack/start-plugin-core dev-server-plugin)
```

`#tanstack-start-entry` is the subpath-imports alias TanStack Start's server core uses to load the project's server entry (our `src/server.ts`, which correctly exports `{ fetch }` via `createStartHandler(defaultStreamHandler)`).

`vite.config.ts` is currently hand-written and calls the raw plugin:

```ts
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
...
plugins: [
  ...tanstackStart({
    router: { entry: "./router.tsx", generatedRouteTree: "./routeTree.gen.ts" },
  }),
  react(),
  ...
]
```

It configures `router.entry` but **never sets `server.entry`**, and it does not go through `@lovable.dev/vite-tanstack-config` (the wrapper is installed in `node_modules/@lovable.dev/vite-tanstack-config` but unused). The lovable wrapper is what registers the `#tanstack-start-entry` alias pointing at `src/server.ts`. Without it, `@tanstack/start-server-core` cannot resolve the entry, throws during `loadEntries`, h3 catches it and returns a 500 for every request — including `/`.

Consequences that produced every visible symptom:

1. The SSR shell is never rendered, so the response HTML contains none of the `<link rel="stylesheet">` / `<script type="module">` tags that `HeadContent` + `Scripts` inject. The browser gets a near-empty document → "renders as almost pure HTML", no Tailwind, no tokens.
2. When the client bundle eventually loads (or fails to), React tries to hydrate against markup that doesn't match anything → "Hydration failed / server HTML replaced with client content".

Both symptoms disappear the moment SSR can resolve the server entry.

Ruled out during investigation:
- `tailwind.config.ts`, `postcss.config.js`, `@tailwind` directives, `src/styles.css`, `src/index.css`, `src/design-system/tokens.css` — all intact and correct.
- `__root.tsx` correctly imports both CSS files and renders `<HeadContent />` + `<Scripts />`.
- `src/App.tsx`, providers, `ThemeProvider`, `BrowserRouter` bootstrap — unchanged and correct.
- Random values / browser globals during render — not the cause (SSR never runs).
- `src/server.ts` — present and correctly shaped.

## Fix (root-cause repair, not a workaround)

Replace `vite.config.ts` with a `@lovable.dev/vite-tanstack-config` `defineConfig` that:

1. Sets `tanstackStart.server.entry = "server"` → registers the `#tanstack-start-entry` alias to `src/server.ts`. This alone eliminates the 500.
2. Keeps `tanstackStart.router.entry = "./router.tsx"` and `generatedRouteTree = "./routeTree.gen.ts"` so the existing (intentionally minimal) TanStack router + the legacy react-router-dom SPA mounted inside `src/routes/index.tsx` and `src/routes/$.tsx` keep working exactly as documented in `router.tsx`.
3. Preserves every other current behavior verbatim: `base: process.env.ELECTRON_BUILD ? './' : '/'`, dev server on `::` port 8080, `@vitejs/plugin-react-swc`, `lovable-tagger` in development, `vite-plugin-pwa` config (disabled for `ELECTRON_BUILD`, otherwise full manifest / workbox / runtime caching), and the `@` → `./src` alias.

No changes to `src/server.ts`, `src/router.tsx`, `src/routes/__root.tsx`, `src/routes/index.tsx`, `src/App.tsx`, CSS files, Tailwind config, PostCSS config, or providers. No `ssr: false`, no StrictMode removal, no hydration suppression, no forced client-only shell.

## Verification checklist

After the config change and a dev-server restart:

- `curl -sS -o /dev/null -w '%{http_code}' http://localhost:8080/` returns `200`.
- Response HTML contains a `<link rel="stylesheet" ...>` for the compiled Tailwind stylesheet and the module script for the client entry.
- No `Cannot find module '#tanstack-start-entry'` lines in the Vite daemon log after restart.
- Browser: landing page renders with full ERP styling (colors, spacing, sidebar theme), no hydration-mismatch warning in the console.
- Navigation into an internal route still routes through the react-router-dom SPA inside `<App />` (as intended by `src/router.tsx`'s comments).

## Technical notes

- `@lovable.dev/vite-tanstack-config`'s `defineConfig` is the sanctioned wrapper on this stack; it wires the `#tanstack-start-entry` subpath import in addition to any options passed under `tanstackStart`. The knowledge card `tanstack-ssr-error-handling` explicitly requires this wrapper for `server.entry` overrides to take effect.
- The stray file `vite.config.ts.timestamp-1769837119628-....mjs` at the project root is a leftover Vite temp from before the migration and unrelated to the incident; it is not loaded by Vite. It can be safely deleted for hygiene but is not part of the fix.
- If, after applying the fix, any residual hydration warning appears on a specific route, that would be a separate, narrower issue to diagnose from a working SSR baseline — not a reason to disable SSR or wrap more of the tree in `ClientOnly`.

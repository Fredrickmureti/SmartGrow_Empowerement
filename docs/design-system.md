# ERP Design System

Single source of truth for the entire platform's UX. **No module ships its
own shell, navigation, page header, table chrome, empty state, or status
pill.** Every module imports primitives from `@/design-system` and
configures them — never reimplements them.

## The hard rules

1. **One shell.** Every authenticated screen renders inside
   `<PlatformShell>` (re-exported from `@/design-system`). Modules do
   not author `<header>`, `<aside>`, or sidebar markup.
2. **One source of navigation truth per workspace.** Each workspace
   exposes a `nav.ts` (`src/apps/<workspace>/nav.ts`) exporting a
   `WorkspaceNav` consumed by `PlatformShell`. Adding a sidebar entry =
   one line in that file.
3. **No horizontal tab rows as primary navigation.** Tabs are reserved
   for **peer views of the same record** (Profile · Documents · History
   on an employee detail). They are never used to surface module
   sections — that is what the sidebar is for.
4. **Configuration is always a sub-route of its workspace** at
   `/<workspace>/configuration`. It is never a top-level destination,
   never duplicated, never above the sidebar.
5. **Reports live per-workspace** at `/<workspace>/reports`. A
   cross-domain Reports workspace exists for org-wide analytics.
6. **Tokens, never literals.** Spacing, type, radii, elevation come from
   `--ds-*` tokens in `src/design-system/tokens.css`. Modules MUST NOT
   hard-code `text-[14px]`, `p-[18px]`, `rounded-[7px]`, etc.
7. **Enforced.** ESLint's `no-restricted-imports` rule (see
   `eslint.config.js`) blocks every deprecated nav import in new code.
   The legacy allowlist shrinks workspace by workspace — never grow it.

## Architecture

```
┌──┬─────┬────────────────────────────────────────────┐
│A │     │  WorkspaceHeader   crumbs · ⌘K · actions    │
│p │ Side├────────────────────────────────────────────┤
│p │ bar │                                             │
│  │     │  PageHeader  eyebrow · title · actions      │
│R │     ├────────────────────────────────────────────┤
│a │     │                                             │
│i │     │  PageBody                                   │
│l │     │   └─ Section title · description · actions  │
│  │     │       └─ children                           │
└──┴─────┴────────────────────────────────────────────┘
```

- **AppRail** (56 px, always visible) — switches workspaces. Active app
  gets an accent stripe. Tooltips only; the rail never shows labels.
- **WorkspaceSidebar** (248 px, collapsible to 56 px icons) — the active
  workspace's groups + items, read from the registry. Vertical overflow
  scrolls; there is **no horizontal hide-behind-arrow behavior**.
- **WorkspaceHeader** (52 px) — breadcrumbs, global search, notifications,
  user. Never workspace-specific nav.
- **PageHeader** — the only approved place for a page title and its
  primary actions. Tabs slot below the title.
- **PageBody / Section** — vertical rhythm and card-style chrome.

## Adding a new module

1. Add a `WorkspaceDefinition` entry to `src/design-system/registry.ts`
   with id, label, icon, accent, route, and your sidebar groups.
2. Author each route with this skeleton:

   ```tsx
   import {
     WorkspaceShell, PageHeader, PageBody, Section,
   } from "@/design-system";

   export function MyPage() {
     return (
       <WorkspaceShell>
         <PageHeader title="My page" description="What it does." />
         <PageBody>
           <Section title="Overview">…</Section>
         </PageBody>
       </WorkspaceShell>
     );
   }
   ```

3. That is the entire integration. No sidebar wiring, no header wiring,
   no breadcrumbs plumbing — the shell figures it out from the registry
   and the URL.

## Primitive catalogue

| Primitive       | Use for                                                  |
| --------------- | -------------------------------------------------------- |
| `WorkspaceShell`| Root of every authenticated screen.                       |
| `PageHeader`    | Page title + primary actions.                             |
| `PageBody`      | Vertical container under PageHeader.                      |
| `Section`       | Titled card block inside PageBody.                        |
| `DetailLayout`  | Two-column record view (main + aside).                    |
| `FilterBar`     | Search + chip filters above a table.                      |
| `ActionBar`     | Right-aligned button cluster inside PageHeader/Section.   |
| `StatusBadge`   | All status pills. Tones: neutral/info/success/warning/danger/accent. |
| `EmptyState`    | "Nothing here yet" surfaces with an action.               |
| `LoadingState`  | Skeleton rows while data loads.                           |
| `ErrorState`    | Failed data + retry action.                               |

## Deprecated — do not import

The following live under `src/components/navigation/*` and exist only so
unmigrated modules keep rendering. Importing them in new code is a bug:

- `AppLayout`, `AppAwareSidebar`, `AppTopNavbar`, `AppNavbar`,
  `AppModuleTabs`, `ReportsSubNav`, `NavigationModeToggle`.

They log a `[deprecated]` warning on mount; future PRs that touch a
module migrating onto `WorkspaceShell` should delete these imports.

## Out of scope (intentionally)

- Tailwind v3 → v4 migration. Tokens are stack-neutral; the migration is
  a separate, isolated task and not required by the design system.
- Refactoring every legacy module page-by-page. The shell + registry
  unblock module migrations; they happen workspace-by-workspace.

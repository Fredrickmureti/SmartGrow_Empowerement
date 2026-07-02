/**
 * Page-template primitives. Every page composes from this module.
 *
 * Rule of thumb:
 *   <PlatformShell> ── workspace chrome (rail + sidebar + topbar)
 *     └─ one *Shell  ── page skeleton (slots: header / tabs / toolbar / content)
 *         ├─ <PageHeader>   page title, description, primary action, scope
 *         ├─ <PageTabs>     optional in-page tab strip (URL-routed)
 *         └─ <PageToolbar>  optional search / filters / view switcher
 *
 * No bespoke page headers. No nested tab strips. No module-specific layouts.
 */
export { PageHeader } from "./PageHeader";
export { PageToolbar } from "./PageToolbar";
export { PageTabs, type PageTab } from "./PageTabs";
export {
  ListShell,
  DetailShell,
  FormShell,
  ReportShell,
  DashboardShell,
  SettingsShell,
} from "./Shells";
export { EmptyState, ErrorState, LoadingState } from "./States";

/**
 * Page shells — opinionated skeletons with fixed slot composition.
 *
 * Pages MUST compose exactly one *Shell. Bespoke page layouts are banned;
 * if a real new shape is needed, add it here so every page inherits it.
 *
 * All shells assume they render inside PlatformShell's content area —
 * they own *page* chrome, not workspace chrome.
 */
import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface BaseShellProps {
  /** PageHeader instance. */
  header: ReactNode;
  /** Optional PageTabs immediately under the header. */
  tabs?: ReactNode;
  /** Optional PageToolbar between tabs and content. */
  toolbar?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** ListShell — index pages (tables, card grids). */
export function ListShell({ header, tabs, toolbar, children, className }: BaseShellProps) {
  return (
    <div className={cn("w-full", className)}>
      {header}
      {tabs}
      {toolbar}
      <div className="rounded-lg border border-border bg-card">{children}</div>
    </div>
  );
}

interface DetailShellProps extends BaseShellProps {
  /** Optional right rail (e.g. activity, related records). */
  aside?: ReactNode;
  /** Sticky bottom action bar. */
  footer?: ReactNode;
}

/** DetailShell — single-record pages with optional aside + footer. */
export function DetailShell({
  header,
  tabs,
  toolbar,
  children,
  aside,
  footer,
  className,
}: DetailShellProps) {
  return (
    <div className={cn("w-full pb-20", className)}>
      {header}
      {tabs}
      {toolbar}
      <div
        className={cn(
          "grid gap-6",
          aside ? "lg:grid-cols-[minmax(0,1fr)_320px]" : "grid-cols-1",
        )}
      >
        <div className="min-w-0 space-y-6">{children}</div>
        {aside && <aside className="space-y-4">{aside}</aside>}
      </div>
      {footer && (
        <div className="fixed bottom-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur px-6 py-3 left-0 md:left-[296px]">
          <div className="mx-auto max-w-6xl flex items-center justify-end gap-2">
            {footer}
          </div>
        </div>
      )}
    </div>
  );
}

/** FormShell — create/edit forms. Centers a single column; footer for submit row. */
export function FormShell({
  header,
  tabs,
  toolbar,
  children,
  footer,
  className,
}: BaseShellProps & { footer?: ReactNode }) {
  return (
    <div className={cn("w-full pb-20", className)}>
      {header}
      {tabs}
      {toolbar}
      <div className="mx-auto max-w-3xl space-y-6">{children}</div>
      {footer && (
        <div className="fixed bottom-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur px-6 py-3 left-0 md:left-[296px]">
          <div className="mx-auto max-w-3xl flex items-center justify-end gap-2">
            {footer}
          </div>
        </div>
      )}
    </div>
  );
}

/** ReportShell — analytical / report pages. Roomy padding, no card wrapper. */
export function ReportShell({ header, tabs, toolbar, children, className }: BaseShellProps) {
  return (
    <div className={cn("w-full", className)}>
      {header}
      {tabs}
      {toolbar}
      <div className="space-y-6">{children}</div>
    </div>
  );
}

/** DashboardShell — widget grids; gives each row consistent spacing. */
export function DashboardShell({ header, tabs, toolbar, children, className }: BaseShellProps) {
  return (
    <div className={cn("w-full", className)}>
      {header}
      {tabs}
      {toolbar}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {children}
      </div>
    </div>
  );
}

/** SettingsShell — configuration pages. Two-column with section nav. */
interface SettingsShellProps extends BaseShellProps {
  /** Optional left section-nav (list of in-page sections). */
  sectionNav?: ReactNode;
}
export function SettingsShell({
  header,
  tabs,
  toolbar,
  sectionNav,
  children,
  className,
}: SettingsShellProps) {
  return (
    <div className={cn("w-full", className)}>
      {header}
      {tabs}
      {toolbar}
      <div
        className={cn(
          "grid gap-6",
          sectionNav ? "lg:grid-cols-[220px_minmax(0,1fr)]" : "grid-cols-1",
        )}
      >
        {sectionNav && <nav className="space-y-1">{sectionNav}</nav>}
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </div>
  );
}

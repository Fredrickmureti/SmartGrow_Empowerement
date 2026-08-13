/**
 * WorkspaceSidebar — contextual in-app sidebar driven by a WorkspaceNav.
 *
 * Grouped Operations / Insights / Setup. Items may have children, which
 * render as a collapsible sub-tree (e.g. Setup → Configuration → ...).
 * Collapses to an icon strip on demand; on mobile the same body is
 * rendered inside a Sheet via {@link SidebarBody} (see PlatformShell).
 */
import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown, LayoutGrid, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { AppSwitcher } from "@/components/navigation/AppSwitcher";
import { usePermissions } from "@/hooks/usePermissions";
import type { AppDefinition } from "@/lib/apps/types";
import type { WorkspaceNav, WorkspaceNavItem } from "./types";

interface WorkspaceSidebarProps {
  app: AppDefinition;
  nav: WorkspaceNav;
}

const STORAGE_KEY = "lov:workspace-sidebar:collapsed";

function pathIsActive(pathname: string, item: WorkspaceNavItem): boolean {
  if (item.to && (item.end ? pathname === item.to : pathname.startsWith(item.to))) return true;
  return (item.children ?? []).some((c) => pathIsActive(pathname, c));
}

function Item({
  item,
  collapsed,
  depth = 0,
  onNavigate,
  defaultExpandAll = false,
}: {
  item: WorkspaceNavItem;
  collapsed: boolean;
  depth?: number;
  onNavigate?: () => void;
  defaultExpandAll?: boolean;
}) {
  const { can } = usePermissions();
  const { pathname } = useLocation();

  if (item.permission && !can(item.permission)) return null;

  const hasChildren = (item.children?.length ?? 0) > 0;
  const Icon = item.icon;
  const childActive = useMemo(() => pathIsActive(pathname, item), [pathname, item]);

  if (hasChildren) {
    return (
      <Collapsible defaultOpen={defaultExpandAll || childActive}>
        <CollapsibleTrigger
          className={cn(
            "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors",
            childActive && "text-foreground",
          )}
        >
          {Icon && <Icon className="h-4 w-4 shrink-0" />}
          {!collapsed && (
            <>
              <span className="truncate flex-1 text-left">{item.label}</span>
              <ChevronDown className="h-3.5 w-3.5 opacity-60 transition-transform group-data-[state=open]:rotate-0 group-data-[state=closed]:-rotate-90" />
            </>
          )}
        </CollapsibleTrigger>
        {!collapsed && (
          <CollapsibleContent className="mt-0.5 ml-3 border-l border-border pl-2 space-y-0.5">
            {item.children!.map((c) => (
              <Item
                key={(c.to ?? "") + c.label}
                item={c}
                collapsed={collapsed}
                depth={depth + 1}
                onNavigate={onNavigate}
                defaultExpandAll={defaultExpandAll}
              />
            ))}
          </CollapsibleContent>
        )}
      </Collapsible>
    );
  }

  return (
    <NavLink
      to={item.to ?? "#"}
      end={item.end}
      title={collapsed ? item.label : undefined}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
          isActive
            ? "bg-primary/10 text-primary font-medium"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
          collapsed && "justify-center px-0",
        )
      }
    >
      {Icon && <Icon className="h-4 w-4 shrink-0" />}
      {!collapsed && <span className="truncate flex-1">{item.label}</span>}
      {!collapsed && item.badge && (
        <span className="ml-auto rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {item.badge}
        </span>
      )}
    </NavLink>
  );
}

/**
 * The grouped nav body — reusable inside the desktop aside and the
 * mobile Sheet. `onNavigate` lets the mobile container close on click.
 */
export function SidebarBody({
  app,
  nav,
  collapsed = false,
  onNavigate,
  defaultExpandAll = false,
  showAppSwitcher = false,
}: {
  app: AppDefinition;
  nav: WorkspaceNav;
  collapsed?: boolean;
  onNavigate?: () => void;
  defaultExpandAll?: boolean;
  /** Render an app-switcher dropdown next to the app name (mobile sidebar). */
  showAppSwitcher?: boolean;
}) {
  const AppIcon = app.icon;
  return (
    <>
      <div
        className={cn(
          "flex items-center h-12 border-b border-border shrink-0",
          collapsed ? "justify-center px-1" : "gap-2 px-3",
          // Reserve room on the right so the Sheet's absolute close (X) button
          // doesn't sit on top of the app-switcher trigger.
          !collapsed && showAppSwitcher && "pr-12",
        )}
      >
        {!collapsed && (
          <>
            <AppIcon className="h-4 w-4 shrink-0" style={{ color: app.color }} />
            <span className="text-sm font-semibold truncate flex-1">{app.name}</span>
            {showAppSwitcher && (
              <AppSwitcher
                variant="dropdown"
                trigger={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                    aria-label="Switch app"
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                    <span>Switch</span>
                  </Button>
                }
              />
            )}
          </>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {nav.groups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-2 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70 font-medium">
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <Item
                  key={(item.to ?? "") + item.label}
                  item={item}
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                  defaultExpandAll={defaultExpandAll}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
    </>
  );
}

export function WorkspaceSidebar({ app, nav }: WorkspaceSidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    }
  }, [collapsed]);

  return (
    <aside
      aria-label={`${app.name} navigation`}
      className={cn(
        "hidden md:flex h-screen sticky top-0 shrink-0 flex-col border-r border-border bg-background transition-[width] duration-150",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div className="relative flex-1 flex flex-col min-h-0">
        <SidebarBody app={app} nav={nav} collapsed={collapsed} />
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2.5 right-1 h-7 w-7 text-muted-foreground"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </Button>
      </div>
    </aside>
  );
}

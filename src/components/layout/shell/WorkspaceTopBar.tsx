/**
 * WorkspaceTopBar — slim 48px topbar above the page content.
 *
 * Owns: breadcrumb (derived from current route + the app's WorkspaceNav),
 * scope chip (from useDeclaredScope, mounted by pages), command-palette
 * trigger (⌘K), notifications, theme toggle, user avatar opening the
 * profile sheet. No navigation links — all of that lives in the sidebar.
 */
import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, Menu, Search, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { NotificationBell } from "@/components/notifications";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ScopeSwitcherChip } from "@/components/common/ScopeSwitcherChip";
import { UserProfileSheet } from "@/components/profile/UserProfileSheet";
import { useAIAssistantContext } from "@/contexts/AIAssistantContext";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/hooks/useUserProfile";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useCommandPaletteContext } from "@/providers/CommandPaletteProvider";
import { getDisplayName } from "@/lib/user-display-name";
import type { AppDefinition } from "@/lib/apps/types";
import type { WorkspaceNav, WorkspaceNavItem } from "./types";

interface Crumb {
  label: string;
  to?: string;
}

function findMatching(
  pathname: string,
  items: WorkspaceNavItem[],
  trail: WorkspaceNavItem[] = [],
): WorkspaceNavItem[] | null {
  // depth-first; longest match wins
  let best: WorkspaceNavItem[] | null = null;
  for (const item of items) {
    const here = item.to && (item.end ? pathname === item.to : pathname.startsWith(item.to));
    const next = [...trail, item];
    if (here && (!best || next.length > best.length)) best = next;
    if (item.children?.length) {
      const childMatch = findMatching(pathname, item.children, next);
      if (childMatch && (!best || childMatch.length > best.length)) best = childMatch;
    }
  }
  return best;
}

function useCrumbs(app: AppDefinition, nav: WorkspaceNav): Crumb[] {
  const { pathname } = useLocation();
  return useMemo(() => {
    const crumbs: Crumb[] = [{ label: app.name, to: app.basePath }];
    const flatItems = nav.groups.flatMap((g) => g.items);
    const match = findMatching(pathname, flatItems);
    if (match) {
      for (const i of match) crumbs.push({ label: i.label, to: i.to });
    }
    return crumbs;
  }, [app.basePath, app.name, nav, pathname]);
}

interface WorkspaceTopBarProps {
  app: AppDefinition;
  nav: WorkspaceNav;
  onOpenMobileNav?: () => void;
}

export function WorkspaceTopBar({ app, nav, onOpenMobileNav }: WorkspaceTopBarProps) {
  const navigate = useNavigate();
  const crumbs = useCrumbs(app, nav);
  const { openAIChat } = useAIAssistantContext();
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const { currentEmployee } = useCurrentEmployee();
  const palette = useCommandPaletteContext();
  const [profileOpen, setProfileOpen] = useState(false);

  const avatarUrl =
    currentEmployee?.avatar_url ||
    profile?.avatar_url ||
    user?.user_metadata?.avatar_url ||
    null;
  const { displayName, initials } = getDisplayName(currentEmployee, profile, user);

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70 px-4",
      )}
    >
      {onOpenMobileNav && (
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden h-8 w-8 -ml-1"
          onClick={onOpenMobileNav}
          aria-label="Open navigation"
        >
          <Menu className="h-4 w-4" />
        </Button>
      )}
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const mobileHidden = !last && crumbs.length > 1;
          return (
            <span
              key={`${c.label}-${i}`}
              className={cn(
                "flex items-center gap-1 min-w-0",
                mobileHidden && "hidden md:flex",
              )}
            >
              {i > 0 && (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
              )}
              {last || !c.to ? (
                <span className="truncate font-medium text-foreground">{c.label}</span>
              ) : (
                <Link
                  to={c.to}
                  className="truncate text-muted-foreground hover:text-foreground transition-colors"
                >
                  {c.label}
                </Link>
              )}
            </span>
          );
        })}
      </nav>

      {/* Scope chip + canonical scope switcher trigger. */}
      <ScopeSwitcherChip className="shrink-0" />


      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="hidden md:inline-flex h-8 gap-2 text-muted-foreground"
          onClick={() => palette.setOpen(true)}
        >
          <Search className="h-3.5 w-3.5" />
          <span>Search</span>
          <kbd className="ml-1 hidden lg:inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
            ⌘K
          </kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={openAIChat}
          aria-label="AI assistant"
        >
          <Sparkles className="h-4 w-4" />
        </Button>
        <NotificationBell />
        <ThemeToggle collapsed />
        <button
          type="button"
          className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setProfileOpen(true)}
          aria-label="Open profile"
        >
          <Avatar className="h-8 w-8 border border-border">
            <AvatarImage src={avatarUrl || undefined} alt={displayName} />
            <AvatarFallback className="text-xs bg-muted text-muted-foreground">
              {initials}
            </AvatarFallback>
          </Avatar>
        </button>
        <UserProfileSheet open={profileOpen} onOpenChange={setProfileOpen} />
      </div>
    </header>
  );
}

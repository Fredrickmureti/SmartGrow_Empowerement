/**
 * MePortalLayout — chrome for the `/me/*` Employee Self-Service portal.
 *
 * Rebuilt in the ESS consistency wave to structurally mirror the platform's
 * `WorkspaceShellFrame` + `WorkspaceSidebar` composition used by every
 * business app (`/hr`, `/finance`, `/sales`, …). Same grid, same padding
 * tokens, same collapsible left rail with grouped nav (Operations / Records
 * / Account), same mobile Sheet drawer, same slim topbar treatment.
 *
 * We render the primitives inline (rather than mounting `PlatformShell`)
 * because `PlatformShell` intentionally early-returns for `userType ===
 * "portal"` and requires an `AppDefinition`; the ESS portal doesn't have
 * one. The visual/behavioural parity comes from copying the same layout
 * shape, not from re-using the gated wrapper.
 *
 * The redundant horizontal sub-nav that duplicated the rail has been retired
 * as part of this wave.
 */
import { ReactNode, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, useNavigate } from "react-router-dom";
import {
  CalendarOff,
  Clock,
  ClipboardList,
  FileText,
  User as UserIcon,
  Wallet,
  LogOut,
  Menu,
  LayoutDashboard,
  Settings,
  ArrowLeft,
  Target,
  GraduationCap,
  Bell,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NotificationBell } from "@/components/notifications";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { useAuth } from "@/contexts/AuthContext";
import { useSession } from "@/contexts/SessionContext";
import { useUserProfile } from "@/hooks/useUserProfile";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useEntitlementGate } from "@/hooks/useEntitlementGate";
import { useOrganization } from "@/hooks/useOrganization";
import { getDisplayName } from "@/lib/user-display-name";

interface NavItemDef {
  to: string;
  label: string;
  icon: typeof CalendarOff;
  /** If set, hide unless the org has the app entitled. */
  gateAppId?: "payroll" | "timesheets";
  /** End-match (used for the root /me link). */
  end?: boolean;
}

interface NavGroupDef {
  label: string;
  items: NavItemDef[];
}

/**
 * Grouped navigation — structural parity with `WorkspaceSidebar`
 * (Operations / Insights / Setup pattern). Portal groups: Operations
 * (day-to-day time affordances), Records (statements and personal HR
 * files), Account (identity + preferences).
 */
const NAV_GROUPS: NavGroupDef[] = [
  {
    label: "Operations",
    items: [
      { to: "/me",            label: "Home",        icon: LayoutDashboard, end: true },
      { to: "/me/leave",      label: "Time off",    icon: CalendarOff },
      { to: "/me/timesheets", label: "Timesheets",  icon: Clock,        gateAppId: "timesheets" },
      { to: "/me/attendance", label: "Attendance",  icon: ClipboardList },
      { to: "/me/shifts",     label: "Shifts",      icon: ClipboardList },
    ],
  },
  {
    label: "Development",
    items: [
      { to: "/me/talent",     label: "Talent",      icon: Target },
      { to: "/me/learning",   label: "Learning",    icon: GraduationCap },
      { to: "/me/onboarding", label: "Onboarding",  icon: ClipboardList },
    ],
  },
  {
    label: "Records",
    items: [
      { to: "/me/payslips",         label: "Payslips",         icon: Wallet },
      { to: "/me/tax-certificates", label: "Tax certificates", icon: FileText, gateAppId: "payroll" },
      { to: "/me/loans",            label: "Loans",            icon: Wallet,   gateAppId: "payroll" },
      { to: "/me/documents",        label: "Documents",        icon: FileText },
    ],
  },
  {
    label: "Account",
    items: [
      { to: "/me/profile",        label: "Profile",       icon: UserIcon },
      { to: "/me/account",        label: "Account",       icon: KeyRound },
      { to: "/me/notifications",  label: "Notifications", icon: Bell },
    ],
  },
];

function useVisibleGroups(): NavGroupDef[] {
  const payroll = useEntitlementGate("payroll", "read");
  const timesheets = useEntitlementGate("timesheets", "read");
  return useMemo(
    () =>
      NAV_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((i) => {
          if (i.gateAppId === "payroll") return payroll.allowed;
          if (i.gateAppId === "timesheets") return timesheets.allowed;
          return true;
        }),
      })).filter((g) => g.items.length > 0),
    [payroll.allowed, timesheets.allowed],
  );
}

function SidebarBody({
  collapsed,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const groups = useVisibleGroups();
  return (
    <>
      <div
        className={cn(
          "flex items-center h-12 border-b border-border shrink-0",
          collapsed ? "justify-center px-1" : "gap-2 px-3",
        )}
      >
        <LayoutDashboard className="h-4 w-4 shrink-0 text-primary" />
        {!collapsed && (
          <span className="text-sm font-semibold truncate flex-1">My Workspace</span>
        )}
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {groups.map((group) => (
          <div key={group.label}>
            {!collapsed && (
              <div className="px-2 pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70 font-medium">
                {group.label}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    title={collapsed ? item.label : undefined}
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
                    <Icon className="h-4 w-4 shrink-0" />
                    {!collapsed && <span className="truncate flex-1">{item.label}</span>}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </>
  );
}

const COLLAPSE_STORAGE_KEY = "lov:me-portal-sidebar:collapsed";

export function MePortalLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, signOut } = useAuth();
  const { profile } = useUserProfile();
  const { currentEmployee } = useCurrentEmployee();
  const { currentOrg } = useOrganization();
  const { userType } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? "1" : "0");
    }
  }, [collapsed]);

  // Internal users (admins, HR officers, anyone with business-app access)
  // need an explicit way back to the main workspace. Portal-only employees
  // don't — clicking it would just bounce them back to /me.
  const canReturnToWorkspace = userType !== null && userType !== "portal";

  const avatarUrl =
    currentEmployee?.avatar_url ||
    profile?.avatar_url ||
    user?.user_metadata?.avatar_url ||
    null;
  const { displayName, initials } = getDisplayName(currentEmployee, profile, user);

  const handleSignOut = async () => {
    try {
      await queryClient.cancelQueries();
      queryClient.clear();
      await signOut();
      navigate("/login", { replace: true });
    } catch (e) {
      console.error("[MePortalLayout] sign out failed", e);
    }
  };

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Desktop rail — mirrors WorkspaceSidebar shape */}
      <aside
        aria-label="My Workspace navigation"
        className={cn(
          "hidden md:flex h-screen sticky top-0 shrink-0 flex-col border-r border-border bg-background transition-[width] duration-150",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <div className="relative flex-1 flex flex-col min-h-0">
          <SidebarBody collapsed={collapsed} />
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

      {/* Mobile drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-80 p-0 flex flex-col">
          <SidebarBody onNavigate={() => setMobileOpen(false)} />
          {canReturnToWorkspace && (
            <div className="border-t p-2 shrink-0">
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => setMobileOpen(false)}
              >
                <Link to="/">
                  <ArrowLeft className="h-4 w-4" />
                  Back to workspace
                </Link>
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className="flex flex-1 flex-col min-w-0">
        {/* Slim topbar — 48px, matches WorkspaceTopBar height */}
        <header className="sticky top-0 z-40 h-12 flex items-center gap-3 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-3 sm:px-6">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden -ml-1" aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
          </Sheet>

          <div className="min-w-0 hidden sm:flex items-center gap-2">
            <span className="text-sm font-semibold">My Workspace</span>
            {currentOrg?.name ? (
              <>
                <span className="text-muted-foreground/50 text-xs">/</span>
                <span className="text-xs text-muted-foreground truncate max-w-[220px]">
                  {currentOrg.name}
                </span>
              </>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-1">
            {canReturnToWorkspace && (
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="hidden md:inline-flex gap-1.5 text-muted-foreground hover:text-foreground"
                title="Return to the business workspace"
              >
                <Link to="/">
                  <ArrowLeft className="h-4 w-4" />
                  <span>Back to workspace</span>
                </Link>
              </Button>
            )}
            <NotificationBell />
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-9 px-2 gap-2" aria-label="User menu">
                  <Avatar className="h-7 w-7">
                    {avatarUrl ? <AvatarImage src={avatarUrl} alt={displayName} /> : null}
                    <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                  </Avatar>
                  <span className="hidden sm:inline text-sm font-medium max-w-[160px] truncate">
                    {displayName}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium truncate">{displayName}</span>
                    {user?.email ? (
                      <span className="text-xs text-muted-foreground truncate">{user.email}</span>
                    ) : null}
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/me/profile">
                    <UserIcon className="h-4 w-4 mr-2" /> My profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/me/account">
                    <KeyRound className="h-4 w-4 mr-2" /> Account
                  </Link>
                </DropdownMenuItem>
                {canReturnToWorkspace && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to="/">
                        <ArrowLeft className="h-4 w-4 mr-2" /> Back to workspace
                      </Link>
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSignOut}>
                  <LogOut className="h-4 w-4 mr-2" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-4">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export default MePortalLayout;

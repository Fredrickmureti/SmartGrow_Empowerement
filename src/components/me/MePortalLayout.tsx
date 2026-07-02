/**
 * MePortalLayout — purpose-built chrome for the `/me/*` Employee Self-Service
 * portal.
 *
 * Replaces `AppWorkspaceLayout` (the business-app shell) inside `MeApp` so
 * portal users (and admins viewing /me) get an ESS-shaped surface:
 *   - Slim topbar: workspace name, notifications, theme toggle, user menu.
 *     NO app launcher, NO app marketplace, NO Subscriptions, NO admin Settings.
 *   - Left rail: the eight `/me/*` destinations with current-route highlight.
 *     Collapses behind a sheet on mobile.
 *
 * This is the enterprise-grade ESS chrome described in `.lovable/plan.md`
 * Step 5. It applies uniformly regardless of whether the user is a regular
 * employee or an internal admin who navigated to /me — the boundary stays
 * clean either way.
 */
import { ReactNode, useMemo, useState } from "react";
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
import { MeSubNav } from "@/components/me/MeSubNav";

interface NavItemDef {
  to: string;
  label: string;
  icon: typeof CalendarOff;
  /** If set, hide unless the org has the app entitled. */
  gateAppId?: "payroll" | "timesheets";
  /** End-match (used for the root /me link). */
  end?: boolean;
}

const NAV_ITEMS: NavItemDef[] = [
  { to: "/me",            label: "Home",        icon: LayoutDashboard, end: true },
  { to: "/me/talent",     label: "Talent",      icon: Target },
  { to: "/me/learning",   label: "Learning",    icon: GraduationCap },
  { to: "/me/leave",      label: "Time off",    icon: CalendarOff },
  { to: "/me/timesheets", label: "Timesheets",  icon: Clock,        gateAppId: "timesheets" },
  { to: "/me/attendance", label: "Attendance",  icon: ClipboardList },
  { to: "/me/shifts",     label: "Shifts",      icon: ClipboardList },
  { to: "/me/onboarding", label: "Onboarding",  icon: ClipboardList },
  { to: "/me/payslips",         label: "Payslips",          icon: Wallet },
  { to: "/me/tax-certificates", label: "Tax certificates",  icon: FileText,     gateAppId: "payroll" },
  { to: "/me/loans",            label: "Loans",             icon: Wallet,       gateAppId: "payroll" },
  { to: "/me/documents",        label: "Documents",         icon: FileText },
  { to: "/me/profile",    label: "Profile",     icon: UserIcon },
  { to: "/me/settings",   label: "My settings", icon: Settings },
];

function useVisibleNav(): NavItemDef[] {
  const payroll = useEntitlementGate("payroll", "read");
  const timesheets = useEntitlementGate("timesheets", "read");
  return useMemo(
    () =>
      NAV_ITEMS.filter((i) => {
        if (i.gateAppId === "payroll") return payroll.allowed;
        if (i.gateAppId === "timesheets") return timesheets.allowed;
        return true;
      }),
    [payroll.allowed, timesheets.allowed],
  );
}

function NavList({ onNavigate }: { onNavigate?: () => void }) {
  const items = useVisibleNav();
  return (
    <nav className="flex flex-col gap-1 p-2">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export function MePortalLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, signOut } = useAuth();
  const { profile } = useUserProfile();
  const { currentEmployee } = useCurrentEmployee();
  const { currentOrg } = useOrganization();
  const { userType } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);

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
      // Sign-out hygiene: cancel in-flight queries and clear cached
      // protected data before clearing the session so a Back-button press
      // can't restore portal data, then redirect to the real auth route
      // (`/login` — there is no `/auth` route in this app's router).
      await queryClient.cancelQueries();
      queryClient.clear();
      await signOut();
      navigate("/login", { replace: true });
    } catch (e) {
      console.error("[MePortalLayout] sign out failed", e);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Slim topbar */}
      <header className="sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 items-center gap-3 px-3 sm:px-6">
          {/* Mobile menu */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64">
              <div className="px-4 py-4 border-b">
                <p className="text-sm font-semibold">My Workspace</p>
                {currentOrg?.name ? (
                  <p className="text-xs text-muted-foreground truncate">{currentOrg.name}</p>
                ) : null}
              </div>
              <NavList onNavigate={() => setMobileOpen(false)} />
              {canReturnToWorkspace && (
                <div className="border-t p-2">
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

          <Link to="/me" className="flex items-center gap-2 min-w-0">
            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <LayoutDashboard className="h-4 w-4" />
            </div>
            <div className="min-w-0 hidden sm:block">
              <p className="text-sm font-semibold leading-none">My Workspace</p>
              {currentOrg?.name ? (
                <p className="text-xs text-muted-foreground truncate">{currentOrg.name}</p>
              ) : null}
            </div>
          </Link>

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
                  <Link to="/me/settings">
                    <Settings className="h-4 w-4 mr-2" /> My settings
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
        </div>
      </header>

      {/* Body: sidebar + content */}
      <div className="flex-1 flex min-h-0">
        <aside className="hidden md:flex w-60 shrink-0 border-r flex-col">
          <div className="px-4 py-3 border-b">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
              Self-service
            </p>
          </div>
          <div className="flex-1 overflow-y-auto">
            <NavList />
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-x-hidden">
          <div className="p-4 sm:p-6 max-w-6xl mx-auto w-full">
            <MeSubNav />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export default MePortalLayout;

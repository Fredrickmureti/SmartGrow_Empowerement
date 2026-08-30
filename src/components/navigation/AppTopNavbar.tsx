/**
 * AppTopNavbar Component
 * 
 * Top navigation bar for app workspace mode.
 * Features:
 * - App switcher (grid icon)
 * - Current app dropdown
 * - Horizontal module tabs
 * - Search, notifications, user actions
 */

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  LayoutGrid,
  ChevronDown,
  Home,
  Menu,
  Sparkles,
  X,
} from "lucide-react";
import { useAIAssistantContext } from "@/contexts/AIAssistantContext";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { NotificationBell } from "@/components/notifications";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { DeclaredScopeChip } from "@/components/common/DeclaredScopeChip";
import { UserProfileSheet } from "@/components/profile/UserProfileSheet";
import { AppModuleTabs } from "./AppModuleTabs";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { useAuth } from "@/contexts/AuthContext";
import { useUserProfile } from "@/hooks/useUserProfile";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { getDisplayName } from "@/lib/user-display-name";
import type { AppDefinition } from "@/lib/apps/types";

interface AppTopNavbarProps {
  app: AppDefinition;
  className?: string;
}

export function AppTopNavbar({ app, className }: AppTopNavbarProps) {
  const navigate = useNavigate();
  const [appSwitcherOpen, setAppSwitcherOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileSheetOpen, setProfileSheetOpen] = useState(false);
  const { availableApps, navigateToApp, getAccessibleModules } = useAppNavigation();
  const { openAIChat } = useAIAssistantContext();
  const { user } = useAuth();
  const { profile } = useUserProfile();
  const { currentEmployee } = useCurrentEmployee();
  const avatarUrl = currentEmployee?.avatar_url || profile?.avatar_url || user?.user_metadata?.avatar_url || null;
  const { displayName, initials } = getDisplayName(currentEmployee, profile, user);

  // Filter out current app and platform apps from switcher
  const otherApps = availableApps.filter(a => a.id !== app.id && !a.alwaysAvailable);
  const showAppSwitcher = !app.hideAppSwitcher;

  return (
    <header
      className={cn(
        "sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
        className
      )}
    >
      <div className="flex h-14 items-center px-4 gap-4">
        {/* Left Section: App Switcher + Current App */}
        <div className="flex items-center gap-2">
          {/* Home / App Grid Button */}
          {showAppSwitcher && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => setAppSwitcherOpen(true)}
            >
              <LayoutGrid className="h-5 w-5" />
              <span className="sr-only">App Switcher</span>
            </Button>
          )}

          {/* Current App: dropdown when switchable, static brand otherwise */}
          {showAppSwitcher ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="gap-2 font-semibold"
                style={{ color: app.color }}
              >
                <app.icon className="h-4 w-4" />
                <span className="hidden sm:inline">{app.name}</span>
                <ChevronDown className="h-4 w-4 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Switch App</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {otherApps.map((otherApp) => (
                <DropdownMenuItem
                  key={otherApp.id}
                  onClick={() => navigateToApp(otherApp.id)}
                  className="gap-2"
                >
                  <otherApp.icon
                    className="h-4 w-4"
                    style={{ color: otherApp.color }}
                  />
                  <span>{otherApp.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => navigate("/dashboard")}
                className="gap-2"
              >
                <Home className="h-4 w-4" />
                <span>Back to Home</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          ) : (
            <div
              className="flex items-center gap-2 px-3 font-semibold"
              style={{ color: app.color }}
            >
              <app.icon className="h-4 w-4" />
              <span className="hidden sm:inline">{app.name}</span>
            </div>
          )}
        </div>

        {/* Separator */}
        <div className="hidden md:block h-6 w-px bg-border" />

        {/* Module Tabs - Desktop */}
        <div className="hidden md:flex flex-1 min-w-0">
          <AppModuleTabs app={app} />
        </div>

        {/* Mobile: profile + menu */}
        <div className="md:hidden flex items-center gap-1 ml-auto">
          <button
            className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setProfileSheetOpen(true)}
            aria-label="Open profile"
          >
            <Avatar className="h-8 w-8 border border-border">
              <AvatarImage src={avatarUrl || undefined} alt={displayName} />
              <AvatarFallback className="text-xs bg-muted text-muted-foreground">{initials}</AvatarFallback>
            </Avatar>
          </button>
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <Menu className="h-5 w-5" />
                <span className="sr-only">Open menu</span>
              </Button>
            </SheetTrigger>
          <SheetContent side="right" className="w-[280px] p-0">
            <div className="flex flex-col h-full">
              <div className="p-4 border-b">
                <div className="flex items-center gap-2">
                  <app.icon className="h-5 w-5" style={{ color: app.color }} />
                  <span className="font-semibold">{app.name}</span>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-2">
                {getAccessibleModules(app)
                  .filter((m) => !m.hidden)
                  .map((module) => (
                    <Link
                      key={module.id}
                      to={`${app.basePath}${module.path}`}
                      onClick={() => setMobileMenuOpen(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent"
                    >
                      <module.icon className="h-4 w-4" />
                      <span>{module.name}</span>
                    </Link>
                  ))}
              </div>
              <div className="p-4 border-t space-y-2">
                <Button
                  variant="outline"
                  className="w-full gap-2"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    openAIChat();
                  }}
                >
                  <Sparkles className="h-4 w-4" />
                  AI Assistant
                </Button>
                {showAppSwitcher && (
                  <Button
                    variant="outline"
                    className="w-full gap-2"
                    onClick={() => {
                      setMobileMenuOpen(false);
                      navigate("/dashboard");
                    }}
                  >
                    <Home className="h-4 w-4" />
                    Back to Home
                  </Button>
                )}
              </div>
            </div>
          </SheetContent>
        </Sheet>
        </div>

        {/* Right Section: Actions */}
        <div className="hidden md:flex items-center gap-2 ml-auto">
          <DeclaredScopeChip />
          <Button variant="ghost" size="icon" className="h-9 w-9" onClick={openAIChat}>
            <Sparkles className="h-5 w-5" />
            <span className="sr-only">AI Assistant</span>
          </Button>
          <ThemeToggle />
          <NotificationBell />
          <button
            className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ml-1"
            onClick={() => setProfileSheetOpen(true)}
            aria-label="Open profile"
          >
            <Avatar className="h-8 w-8 border border-border hover:border-primary transition-colors">
              <AvatarImage src={avatarUrl || undefined} alt={displayName} />
              <AvatarFallback className="text-xs bg-muted text-muted-foreground">{initials}</AvatarFallback>
            </Avatar>
          </button>
        </div>
      </div>

      {/* App Switcher Dialog */}
      <AppSwitcherDialog
        open={appSwitcherOpen}
        onOpenChange={setAppSwitcherOpen}
        currentAppId={app.id}
      />

      {/* User Profile Sheet — global access from any app workspace */}
      <UserProfileSheet open={profileSheetOpen} onOpenChange={setProfileSheetOpen} />
    </header>
  );
}

interface AppSwitcherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentAppId: string;
}

function AppSwitcherDialog({
  open,
  onOpenChange,
  currentAppId,
}: AppSwitcherDialogProps) {
  const navigate = useNavigate();
  const { appGroups, navigateToApp } = useAppNavigation();

  const handleAppClick = (appId: string) => {
    navigateToApp(appId);
    onOpenChange(false);
  };

  const handleHomeClick = () => {
    navigate("/dashboard");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] !grid-rows-[auto_1fr] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Apps</DialogTitle>
        </DialogHeader>
        <ScrollArea className="h-full max-h-[calc(85vh-80px)]">
          <div className="space-y-6 py-4 pr-4">
            {/* Home Card */}
            <button
              onClick={handleHomeClick}
              className="flex items-center gap-3 p-4 rounded-lg border hover:bg-accent transition-colors w-full text-left"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <Home className="h-5 w-5" />
              </div>
              <div>
                <div className="font-medium">Home</div>
                <div className="text-sm text-muted-foreground">
                  Dashboard & overview
                </div>
              </div>
            </button>

            {/* App Groups */}
            {appGroups.map((group) => (
              <div key={group.label}>
                <h3 className="text-sm font-medium text-muted-foreground mb-3">
                  {group.label}
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {group.apps.map((app) => (
                    <button
                      key={app.id}
                      onClick={() => handleAppClick(app.id)}
                      className={cn(
                        "flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors",
                        app.id === currentAppId
                          ? "bg-accent border-primary"
                          : "hover:bg-accent"
                      )}
                    >
                      <div
                        className="flex h-10 w-10 items-center justify-center rounded-lg"
                        style={{ backgroundColor: `${app.color}15` }}
                      >
                        <app.icon
                          className="h-5 w-5"
                          style={{ color: app.color }}
                        />
                      </div>
                      <span className="text-sm font-medium text-center">
                        {app.name}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

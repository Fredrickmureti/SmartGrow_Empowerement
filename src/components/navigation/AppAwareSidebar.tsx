/**
 * App-Aware Sidebar Component
 * 
 * This sidebar adapts based on the current app context (Finance, Sales, etc.)
 * and shows only relevant navigation items for that app.
 */

import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ChevronDown, ChevronLeft, ChevronRight, LayoutGrid, ChevronsUpDown, Plus, Check, LogOut, Settings, LayoutDashboard, Home, Grid2X2, Sparkles } from "lucide-react";
import { useState, useEffect } from "react";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useUserProfile } from "@/hooks/useUserProfile";
import { UserProfileSheet } from "@/components/profile/UserProfileSheet";
import { useAppNavigation } from "@/hooks/useAppNavigation";
import { usePermissions } from "@/hooks/usePermissions";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";
import { ContextSwitcherSheet } from "@/components/organization/ContextSwitcherSheet";
import { useCanSwitchScope } from "@/hooks/useCanSwitchScope";
// ThemeToggle now lives in AppTopNavbar; intentionally not imported here.
import { useAIAssistantContext } from "@/contexts/AIAssistantContext";
import { getDisplayName } from "@/lib/user-display-name";
import type { AppDefinition, ModuleDefinition } from "@/lib/apps/types";
import { GlobalCreateMenu } from "./GlobalCreateMenu";
interface AppAwareSidebarProps {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onCreateOrg?: () => void;
  /** When true, sidebar renders inline (not fixed) for use inside a Sheet/Drawer */
  inline?: boolean;
}
export function AppAwareSidebar({
  collapsed = false,
  onToggleCollapse,
  onCreateOrg,
  inline = false
}: AppAwareSidebarProps) {
  const location = useLocation();
  const {
    user,
    signOut
  } = useAuth();
  const {
    organizations,
    currentOrg,
    userRole,
    switchOrganization,
    isLoading: isOrgLoading,
  } = useOrganization();
  const {
    currentApp,
    availableApps,
    getAccessibleModules
  } = useAppNavigation();
  const { currentBusiness, businesses, isLoading: isBusinessLoading } = useBusinesses();
  // Treat the org → company chain as "loading" until both layers settle.
  // Without this, the secondary line briefly renders "No company yet —
  // set one up" on cold load before the company resolves (BusinessContext
  // flips isLoading to false a tick before currentBusiness is assigned, and
  // OrganizationContext can hydrate after first paint). Mirrors the same
  // contract used in SidebarContextSwitcher so the two trigger surfaces
  // never disagree.
  const isContextLoading =
    isOrgLoading ||
    isBusinessLoading ||
    (!!currentOrg && !currentBusiness && businesses.length > 0);
  const { currentBranch } = useBranch();
  const permissions = usePermissions();
  const [expandedApps, setExpandedApps] = useState<Set<string>>(new Set());
  const [profileSheetOpen, setProfileSheetOpen] = useState(false);
  const [contextSheetOpen, setContextSheetOpen] = useState(false);
  const { shouldShowTrigger: canSwitchScope } = useCanSwitchScope();
  const { currentEmployee } = useCurrentEmployee();
  const { profile } = useUserProfile();
  const { openAIChat } = useAIAssistantContext();

  const avatarUrl = currentEmployee?.avatar_url || profile?.avatar_url || null;

  const { displayName, initials: userInitials } = (() => {
    const result = getDisplayName(currentEmployee, profile, user);
    return result;
  })();

  const orgInitials = currentOrg?.name?.slice(0, 2).toUpperCase() || "ORG";

  // Auto-expand current app section
  useEffect(() => {
    if (currentApp) {
      setExpandedApps(prev => new Set([...prev, currentApp.id]));
    }
  }, [currentApp?.id]);
  const toggleApp = (appId: string) => {
    setExpandedApps(prev => {
      const next = new Set(prev);
      if (next.has(appId)) {
        next.delete(appId);
      } else {
        next.add(appId);
      }
      return next;
    });
  };
  const isModuleActive = (app: AppDefinition, module: ModuleDefinition) => {
    const fullPath = `${app.basePath}${module.path}`;
    return location.pathname === fullPath || location.pathname.startsWith(fullPath + '/');
  };
  const NavLink = ({
    to,
    icon: Icon,
    label,
    isActive,
    indent = false,
    subtitle,
  }: {
    to: string;
    icon: React.ElementType;
    label: string;
    isActive: boolean;
    indent?: boolean;
    subtitle?: string;
  }) => {
    const linkClassName = cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors", collapsed ? "justify-center px-2" : indent ? "pl-6" : "", isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground");
    if (collapsed) {
      return <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Link to={to} className={linkClassName}>
              <Icon className="h-4 w-4 shrink-0" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            {label}
            {subtitle ? <div className="text-xs text-muted-foreground">{subtitle}</div> : null}
          </TooltipContent>
        </Tooltip>;
    }
    return <Link to={to} className={linkClassName}>
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex flex-col leading-tight">
          <span>{label}</span>
          {subtitle ? <span className="text-[10px] font-normal text-muted-foreground/80">{subtitle}</span> : null}
        </span>
      </Link>;
  };
  const AppSection = ({
    app
  }: {
    app: AppDefinition;
  }) => {
    const isExpanded = expandedApps.has(app.id);
    const accessibleModules = getAccessibleModules(app);
    if (accessibleModules.length === 0) return null;
    const hasActiveModule = accessibleModules.some(m => isModuleActive(app, m));
    const AppIcon = app.icon;
    if (collapsed) {
      // In collapsed mode, show app icon as a link to default module
      const defaultModule = accessibleModules[0];
      return <NavLink to={`${app.basePath}${defaultModule.path}`} icon={AppIcon} label={app.name} isActive={hasActiveModule} />;
    }
    return <Collapsible open={isExpanded} onOpenChange={() => toggleApp(app.id)}>
        <CollapsibleTrigger className="w-full">
          <div className={cn("flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-colors", "hover:bg-secondary/50", hasActiveModule && "text-primary")}>
            <div className="flex items-center gap-3">
              <div className="flex h-6 w-6 items-center justify-center rounded-md" style={{
              backgroundColor: `${app.color}20`,
              color: app.color
            }}>
                <AppIcon className="h-4 w-4" />
              </div>
              <span className="text-sm font-semibold">{app.name}</span>
            </div>
            <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform duration-200", isExpanded && "rotate-180")} />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
          <div className="pt-1 space-y-0.5">
            {accessibleModules.map(module => <NavLink key={module.id} to={`${app.basePath}${module.path}`} icon={module.icon} label={module.name} isActive={isModuleActive(app, module)} indent />)}
          </div>
        </CollapsibleContent>
      </Collapsible>;
  };
  return <aside className={cn(
    "flex flex-col bg-card transition-all duration-300 h-full",
    inline ? "w-full border-none" : cn("fixed inset-y-0 left-0 z-50 border-r", collapsed ? "w-16" : "w-64")
  )}>
      {/* Compact Organization Header */}
      <div className={cn("flex h-14 items-center border-b px-2", inline && "pr-12")}>
        {collapsed ? (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button variant="ghost" className={cn("w-full h-12 p-0 justify-center", !canSwitchScope && "cursor-default")} onClick={canSwitchScope ? () => setContextSheetOpen(true) : undefined} aria-disabled={!canSwitchScope}>
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold overflow-hidden">
                  {/* Per-company logo only (Odoo res.company model). The
                      workspace has no logo of its own. */}
                  {currentBusiness?.logo_url ? (
                    <img src={currentBusiness.logo_url} alt={currentBusiness.name} className="h-full w-full object-cover" />
                  ) : (
                    orgInitials
                  )}
                </div>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Switch context</TooltipContent>
          </Tooltip>
        ) : (
          <div className="flex items-center gap-3 w-full px-1">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold shrink-0 overflow-hidden">
              {currentBusiness?.logo_url ? (
                <img src={currentBusiness.logo_url} alt={currentBusiness.name} className="h-full w-full object-cover" />
              ) : (
                orgInitials
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">
                {currentOrg?.name ?? (isContextLoading ? <span className="inline-block h-3.5 w-28 rounded bg-muted animate-pulse align-middle" /> : "Select Workspace")}
              </p>
              <p className="text-[10px] text-muted-foreground truncate">
                {currentBusiness
                  ? (currentBranch ? `${currentBusiness.name} · ${currentBranch.name}` : currentBusiness.name)
                  : isContextLoading
                    ? <span className="inline-block h-2.5 w-20 rounded bg-muted animate-pulse align-middle" />
                    : "No company yet — set one up"}
              </p>
            </div>
            {canSwitchScope && (
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setContextSheetOpen(true)}>
                <ChevronsUpDown className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </div>

      {canSwitchScope && (
        <ContextSwitcherSheet open={contextSheetOpen} onOpenChange={setContextSheetOpen} onCreateOrg={onCreateOrg} />
      )}

      {/* Collapse Toggle - hidden on mobile (Sheet handles close) */}
      {!inline && (
        <div className={cn("flex px-3 py-2", collapsed ? "justify-center" : "justify-end")}>
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onToggleCollapse}>
                {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {collapsed ? "Expand sidebar" : "Collapse sidebar"}
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Global + Create Menu */}
      <div className={cn("px-2 pb-2", collapsed ? "px-2 flex justify-center" : "")}>
        <GlobalCreateMenu collapsed={collapsed} />
      </div>

      {/* Home Link */}
      <div className={cn("px-2 pb-1", collapsed && "px-2")}>
        <NavLink to="/home" icon={Home} label="Home" subtitle="Your apps & shortcuts" isActive={location.pathname === "/home"} />
      </div>
      
      {/* Apps Marketplace Link — admin-only (Odoo-aligned) */}
      {permissions.canManageApps && (
        <div className={cn("px-2 pb-1", collapsed && "px-2")}>
          <NavLink to="/apps" icon={Grid2X2} label="Apps" isActive={location.pathname === "/apps"} />
        </div>
      )}
      
      {/* Dashboard Link */}
      <div className={cn("px-2 pb-1", collapsed && "px-2")}>
        <NavLink to="/dashboard" icon={LayoutDashboard} label="Dashboard" subtitle="Today's operations" isActive={location.pathname === "/dashboard"} />
      </div>

      {/* AI Assistant Button - Always visible, not buried in scroll */}
      <div className={cn("px-2 pb-2", collapsed && "px-2")}>
        {collapsed ? (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button variant="ghost" className="w-full h-10 p-0 justify-center text-primary hover:bg-primary/10" onClick={openAIChat}>
                <Sparkles className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">AI Assistant</TooltipContent>
          </Tooltip>
        ) : (
          <Button variant="ghost" className="w-full justify-start px-3 h-10 text-sm font-medium text-primary hover:bg-primary/10" onClick={openAIChat}>
            <Sparkles className="h-4 w-4 shrink-0 mr-3" />
            <span>AI Assistant</span>
          </Button>
        )}
      </div>

      {/* Scrollable Content Area - includes App Navigation and Footer */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {/* App Navigation */}
        <nav className="p-2 space-y-1">
          {availableApps.map(app => <AppSection key={app.id} app={app} />)}
        </nav>

        {/* Footer - User Menu & Theme (scrolls with content) */}
        <div className="mt-auto border-t p-2 space-y-1">
        {/* Settings Link */}
        <NavLink to="/settings" icon={Settings} label="Settings" isActive={location.pathname === "/settings"} />
        

        {/* Theme toggle moved to top navbar (next to notifications/profile) */}

        {/* User Menu */}
        {collapsed ? <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button variant="ghost" className="w-full h-10 p-0 justify-center" onClick={() => setProfileSheetOpen(true)}>
                <Avatar className="h-8 w-8">
                  {avatarUrl && (
                    <AvatarImage src={avatarUrl} alt={displayName} />
                  )}
                  <AvatarFallback className="text-xs">{userInitials}</AvatarFallback>
                </Avatar>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {displayName}
            </TooltipContent>
          </Tooltip> : <Button variant="ghost" className="w-full justify-start px-3 h-10" onClick={() => setProfileSheetOpen(true)}>
                <Avatar className="h-7 w-7 mr-3">
                  {avatarUrl && (
                    <AvatarImage src={avatarUrl} alt={displayName} />
                  )}
                  <AvatarFallback className="text-xs">{userInitials}</AvatarFallback>
                </Avatar>
                <div className="flex flex-col items-start text-left">
                  <span className="text-sm font-medium truncate max-w-[140px]">
                    {displayName}
                  </span>
                </div>
              </Button>}
        </div>

        <UserProfileSheet open={profileSheetOpen} onOpenChange={setProfileSheetOpen} />
      </div>
    </aside>;
}
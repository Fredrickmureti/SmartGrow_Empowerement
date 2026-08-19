import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";
import { usePlatformAdmin } from "@/hooks/usePlatformAdmin";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Building2,
  ChevronDown,
  ChevronsUpDown,
  LayoutDashboard,
  Users,
  FileText,
  Receipt,
  PiggyBank,
  BarChart3,
  Settings,
  LogOut,
  Plus,
  UserPlus,
  Check,
  Package,
  BookOpen,
  ShoppingCart,
  CreditCard,
  PanelLeftClose,
  PanelLeft,
  Shield,
  Landmark,
  GitCompare,
  ListFilter,
  Truck,
  RotateCcw,
  Wallet,
  FileCheck,
  ClipboardList,
  Target,
  MonitorSmartphone,
  History,
  Building,
  Calculator,
  Briefcase,
  FolderKanban,
  Clock,
  CalendarOff,
  CalendarCheck,
  Warehouse,
  Wand2,
  
  PenTool,
  FileSpreadsheet,
  LayoutGrid,
  ChefHat,
  Calendar,
  Cpu,
} from "lucide-react";
import { FileEdit } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useMyDraftCount } from "@/hooks/hr/useMyDraftCount";
import { SidebarContextSwitcher } from "@/components/organization/SidebarContextSwitcher";
// ThemeToggle now lives in AppTopNavbar; intentionally not imported here.


import { Permission, PermissionGroupRule, ROLE_HIERARCHY } from "@/lib/permissions";
import { usePermissions } from "@/hooks/usePermissions";
import { useSession } from "@/contexts/SessionContext";
import { getAccessibleAppIdsFromGroupRules } from "@/lib/apps/module-app-map";
const SIDEBAR_SCROLL_KEY = "sidebar-scroll-position";
const SIDEBAR_SECTIONS_KEY = "sidebar-collapsed-sections";

interface NavItem {
  title: string;
  href: string;
  icon: React.ElementType;
  roles?: string[];
  permission?: Permission;
}

interface SectionState {
  pos: boolean;
  sales: boolean;
  purchases: boolean;
  reports: boolean;
  erp: boolean;
  productivity: boolean;
  other: boolean;
  system: boolean;
}

// POS navigation items
const posNavItems: NavItem[] = [
  { title: "POS Dashboard", href: "/pos", icon: MonitorSmartphone, permission: "viewPOS" },
  { title: "POS Reports", href: "/pos/reports", icon: BarChart3, permission: "viewPOS" },
  { title: "Payment Terminals", href: "/pos/payment-terminals", icon: CreditCard, permission: "managePOS" },
  { title: "POS Settings", href: "/pos/settings", icon: Settings, permission: "managePOS" },
];

// Sales category navigation items
const salesNavItems: NavItem[] = [
  { title: "Invoices", href: "/invoices", icon: FileText, permission: "viewSales" },
  { title: "Recurring", href: "/recurring-invoices", icon: Receipt, permission: "viewSales" },
  { title: "Estimates", href: "/estimates", icon: FileText, permission: "viewSales" },
  { title: "Proforma", href: "/proforma-invoices", icon: FileCheck, permission: "viewSales" },
  { title: "Sales Orders", href: "/sales-orders", icon: ClipboardList, permission: "viewSales" },
  { title: "Delivery Notes", href: "/delivery-notes", icon: Truck, permission: "viewSales" },
  { title: "Customer Payments", href: "/customer-payments", icon: Wallet, permission: "viewSales" },
  { title: "Statements", href: "/customer-statements", icon: FileText, permission: "viewSales" },
  { title: "Sales Returns", href: "/sales-returns", icon: RotateCcw, permission: "viewSales" },
  { title: "Credit Notes", href: "/credit-notes", icon: CreditCard, permission: "viewSales" },
  { title: "Customer Credits", href: "/finance/customer-credits", icon: Wallet, permission: "viewFinancials" },
];

// Purchases category navigation items
const purchasesNavItems: NavItem[] = [
  { title: "Bills", href: "/bills", icon: Receipt, permission: "viewPurchases" },
  { title: "Purchase Orders", href: "/purchase-orders", icon: ShoppingCart, permission: "viewPurchases" },
  { title: "Expenses", href: "/expenses", icon: Receipt, permission: "viewPurchases" },
  { title: "Purchase Returns", href: "/purchase-returns", icon: RotateCcw, permission: "viewPurchases" },
];

// Reports category navigation items
const reportNavItems: NavItem[] = [
  { title: "All Reports", href: "/finance/reports", icon: BarChart3, permission: "viewReports" },
  { title: "Intelligence", href: "/business-intelligence", icon: BarChart3, permission: "viewReports" },
  { title: "Financial", href: "/finance/reports/financial", icon: PiggyBank, permission: "viewReports" },
  { title: "Trial Balance", href: "/finance/reports/trial-balance", icon: Calculator, permission: "viewReports" },
  { title: "General Ledger", href: "/finance/reports/general-ledger", icon: BookOpen, permission: "viewReports" },
  { title: "Aging Reports", href: "/finance/reports/aging", icon: Clock, permission: "viewReports" },
  { title: "Sales", href: "/finance/reports/sales", icon: FileText, permission: "viewReports" },
  { title: "Management", href: "/finance/reports/management", icon: BarChart3, permission: "viewReports" },
  { title: "Tax", href: "/finance/reports/tax", icon: Receipt, permission: "viewReports" },
  { title: "Stock", href: "/finance/reports/stock", icon: Package, permission: "viewReports" },
  { title: "Compliance", href: "/compliance", icon: FileText, permission: "viewReports" },
];

// ERP Suite navigation items
const erpNavItems: NavItem[] = [
  { title: "CRM Pipeline", href: "/crm", icon: Briefcase, permission: "viewContacts" },
  { title: "My Activities", href: "/crm/activities", icon: CalendarCheck, permission: "viewContacts" },
  { title: "Projects", href: "/projects", icon: FolderKanban, permission: "viewProjects" },
  { title: "Timesheets", href: "/timesheets", icon: Clock, permission: "viewTimesheets" },
  { title: "Leave", href: "/leave", icon: CalendarOff, permission: "viewLeave" },
];

// Productivity apps navigation items — Documents/Sign/Spreadsheets all retired.
const productivityNavItems: NavItem[] = [];

// Main navigation items - filtered by permissions
const mainNavItems: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { title: "Contacts", href: "/contacts", icon: Users, permission: "viewContacts" },
  { title: "Products", href: "/products", icon: Package, permission: "viewProducts" },
  { title: "Inventory", href: "/inventory", icon: Package, permission: "viewProducts" },
  { title: "Warehouses", href: "/warehouses", icon: Warehouse, permission: "viewProducts" },
  { title: "Employees", href: "/employees", icon: Users, permission: "viewEmployees" },
  { title: "Payroll", href: "/payroll", icon: Calculator, permission: "viewPayroll" },
  { title: "Fixed Assets", href: "/fixed-assets", icon: Building, permission: "viewFinancials" },
  { title: "Accounts", href: "/accounts", icon: BookOpen, permission: "viewFinancials" },
  { title: "Journal Entries", href: "/journal-entries", icon: BookOpen, permission: "viewFinancials" },
  { title: "Fiscal Periods", href: "/fiscal-periods", icon: CalendarCheck, permission: "viewFinancials" },
  { title: "Budgets", href: "/budgets", icon: Target, permission: "viewFinancials" },
  { title: "Banking", href: "/banking", icon: Landmark, permission: "viewFinancials" },
  { title: "Bank Feeds", href: "/bank-feeds", icon: ListFilter, permission: "viewFinancials" },
  { title: "Reconciliation", href: "/finance/reconciliation", icon: GitCompare, permission: "viewFinancials" },
  { title: "Audit Logs", href: "/audit-logs", icon: History, permission: "viewAuditLogs" },
];

const systemNavItems: NavItem[] = [
  { title: "Studio", href: "/studio", icon: Wand2, permission: "editSettings" },
  { title: "Team", href: "/team", icon: UserPlus, permission: "manageTeam" },
  { title: "Hardware", href: "/platform/hardware/devices", icon: Cpu, permission: "editSettings" },
  { title: "Settings", href: "/settings", icon: Settings, permission: "editSettings" },
];

// Cashier-only navigation - minimal sidebar for cashier role
const cashierNavItems: NavItem[] = [
  { title: "POS Dashboard", href: "/pos", icon: MonitorSmartphone },
];

// Helper to get default section state (load from localStorage or default all open)
const getDefaultSectionState = (): SectionState => {
  try {
    const saved = localStorage.getItem(SIDEBAR_SECTIONS_KEY);
    if (saved) {
      return JSON.parse(saved);
    }
  } catch (e) {
    console.warn("Failed to load sidebar section state:", e);
  }
  return { pos: true, sales: true, purchases: true, reports: true, erp: true, productivity: true, other: true, system: true };
};

interface AppSidebarProps {
  onCreateOrg?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function AppSidebar({ onCreateOrg, collapsed = false, onToggleCollapse }: AppSidebarProps) {
  const location = useLocation();
  const { user, signOut } = useAuth();
  const { organizations, currentOrg, userRole, switchOrganization } = useOrganization();
  const { isPlatformAdmin } = usePlatformAdmin();
  const { restaurantSettings } = usePOSSettings();
  const permissions = usePermissions();
  const navRef = useRef<HTMLElement>(null);

  // Get Access Group rules to determine app-level visibility (Odoo Layer 1)
  let accessibleAppIds: Set<string> | null = null;
  try {
    const session = useSession();
    const currentOrgSession = session.currentOrg;
    const groupRules = currentOrgSession?.permission_group_rules as PermissionGroupRule[] | undefined;
    const role = permissions.role;
    const isHighPrivilege = role && ROLE_HIERARCHY[role] >= ROLE_HIERARCHY.admin;
    
    // Only apply group-based filtering for non-admin roles WITH groups assigned
    if (groupRules && groupRules.length > 0 && !isHighPrivilege) {
      accessibleAppIds = getAccessibleAppIdsFromGroupRules(groupRules);
    }
  } catch {
    // SessionContext may not be available
  }

  // Helper: check if a sidebar section's app is accessible via Access Groups
  const isAppVisibleByGroup = (appId: string): boolean => {
    // If no group restrictions (admin, or no groups assigned), show everything
    if (!accessibleAppIds) return true;
    return accessibleAppIds.has(appId);
  };

  // Build dynamic POS nav items based on restaurant settings
  const dynamicPosNavItems: NavItem[] = useMemo(() => {
    const items: NavItem[] = [
      { title: "POS Dashboard", href: "/pos", icon: MonitorSmartphone, permission: "viewPOS" },
    ];
    
    // Add restaurant mode items based on settings
    if (restaurantSettings.restaurant_mode_enabled) {
      items.push({ title: "Floor Plan", href: "/pos/floor-plan", icon: LayoutGrid, permission: "viewPOS" });
    }
    if (restaurantSettings.kitchen_display_enabled) {
      items.push({ title: "Kitchen Display", href: "/pos/kitchen", icon: ChefHat, permission: "viewPOS" });
    }
    if (restaurantSettings.table_bookings_enabled) {
      items.push({ title: "Reservations", href: "/pos/bookings", icon: Calendar, permission: "viewPOS" });
    }
    
    // Always add Reports and Settings at the end
    items.push(
      { title: "POS Reports", href: "/pos/reports", icon: BarChart3, permission: "viewPOS" },
      { title: "POS Settings", href: "/pos/settings", icon: Settings, permission: "managePOS" }
    );
    
    return items;
  }, [restaurantSettings]);

  // Collapsible section state
  const [openSections, setOpenSections] = useState<SectionState>(getDefaultSectionState);

  // Persist section state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(openSections));
    } catch (e) {
      console.warn("Failed to save sidebar section state:", e);
    }
  }, [openSections]);

  // Auto-expand section when navigating to a page within it
  useEffect(() => {
    const path = location.pathname;
    
    // Check which section contains the current path
    if (posNavItems.some(item => path === item.href || (item.href === "/pos" && path.startsWith("/pos/terminal")))) {
      setOpenSections(prev => ({ ...prev, pos: true }));
    } else if (salesNavItems.some(item => path === item.href)) {
      setOpenSections(prev => ({ ...prev, sales: true }));
    } else if (purchasesNavItems.some(item => path === item.href)) {
      setOpenSections(prev => ({ ...prev, purchases: true }));
    } else if (reportNavItems.some(item => path === item.href || path.startsWith("/finance/reports"))) {
      setOpenSections(prev => ({ ...prev, reports: true }));
    } else if (erpNavItems.some(item => path === item.href || path.startsWith("/crm"))) {
      setOpenSections(prev => ({ ...prev, erp: true }));
    } else if (mainNavItems.slice(3).some(item => path === item.href)) {
      setOpenSections(prev => ({ ...prev, other: true }));
    }
  }, [location.pathname]);

  const toggleSection = (section: keyof SectionState) => {
    setOpenSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // Restore sidebar scroll position on mount
  useEffect(() => {
    const savedScroll = sessionStorage.getItem(SIDEBAR_SCROLL_KEY);
    if (navRef.current && savedScroll) {
      navRef.current.scrollTop = parseInt(savedScroll, 10);
    }
  }, []);

  // Track when user last scrolled to avoid fighting their input
  const lastUserScrollAt = useRef<number>(0);

  // Save scroll position on scroll (debounced) and track user interaction
  const handleScroll = useCallback(() => {
    if (navRef.current) {
      sessionStorage.setItem(SIDEBAR_SCROLL_KEY, String(navRef.current.scrollTop));
      lastUserScrollAt.current = Date.now();
    }
  }, []);

  // Scroll to active link after navigation - only when truly needed
  useEffect(() => {
    const timer = setTimeout(() => {
      const nav = navRef.current;
      const activeLink = nav?.querySelector('[data-active="true"]') as HTMLElement | null;
      
      if (!nav || !activeLink) return;
      
      // Skip auto-scroll if user interacted with sidebar recently (within 500ms)
      const timeSinceUserScroll = Date.now() - lastUserScrollAt.current;
      if (timeSinceUserScroll < 500) return;
      
      // Use scroll container coordinates (not viewport rects) for accurate visibility check
      const containerScrollTop = nav.scrollTop;
      const containerHeight = nav.clientHeight;
      const containerScrollBottom = containerScrollTop + containerHeight;
      
      // Get element position relative to the scroll container
      const linkOffsetTop = activeLink.offsetTop;
      const linkOffsetBottom = linkOffsetTop + activeLink.offsetHeight;
      
      // Check if truly outside visible area (no aggressive buffer)
      const isAboveView = linkOffsetTop < containerScrollTop;
      const isBelowView = linkOffsetBottom > containerScrollBottom;
      
      // Only scroll if completely out of view
      if (isAboveView || isBelowView) {
        activeLink.scrollIntoView({ block: "nearest", behavior: "auto" });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [location.pathname]);

  const userInitials = user?.email?.slice(0, 2).toUpperCase() || "U";
  const orgInitials = currentOrg?.name?.slice(0, 2).toUpperCase() || "ORG";

  const canAccessItem = (item: NavItem) => {
    // Check role-based access first (legacy support)
    if (item.roles) {
      if (!userRole) return false;
      if (!item.roles.includes(userRole.role)) return false;
    }
    // Check permission-based access
    if (item.permission) {
      return permissions.can(item.permission);
    }
    return true;
  };

  const NavItemLink = ({ item, isActive }: { item: NavItem; isActive: boolean }) => {
    const linkContent = (
      <Link
        to={item.href}
        data-active={isActive}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          collapsed && "justify-center px-2",
          isActive
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-secondary hover:text-foreground"
        )}
      >
        <item.icon className="h-4 w-4 shrink-0" />
        {!collapsed && <span>{item.title}</span>}
      </Link>
    );

    if (collapsed) {
      return (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            {item.title}
          </TooltipContent>
        </Tooltip>
      );
    }

    return linkContent;
  };

  // Collapsible section component
  const CollapsibleNavSection = ({
    id,
    title,
    items,
    isActiveCheck,
  }: {
    id: keyof SectionState;
    title: string;
    items: NavItem[];
    isActiveCheck?: (item: NavItem) => boolean;
  }) => {
    const filteredItems = items.filter(canAccessItem);
    if (filteredItems.length === 0) return null;

    const isOpen = openSections[id];
    const hasActiveItem = filteredItems.some(item => 
      isActiveCheck ? isActiveCheck(item) : location.pathname === item.href
    );

    // When sidebar is collapsed, just show divider and items without collapsible
    if (collapsed) {
      return (
        <>
          <div className="border-t my-2" />
          {filteredItems.map((item) => {
            const isActive = isActiveCheck ? isActiveCheck(item) : location.pathname === item.href;
            return <NavItemLink key={item.href} item={item} isActive={isActive} />;
          })}
        </>
      );
    }

    return (
      <Collapsible open={isOpen} onOpenChange={() => toggleSection(id)}>
        <CollapsibleTrigger className="w-full pt-3 pb-1">
          <div className={cn(
            "flex items-center justify-between px-3 py-1.5 rounded-md cursor-pointer transition-colors",
            "hover:bg-secondary/50",
            hasActiveItem && "text-primary"
          )}>
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {title}
            </span>
            <ChevronDown 
              className={cn(
                "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
                isOpen && "rotate-180"
              )} 
            />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=open]:animate-accordion-down data-[state=closed]:animate-accordion-up">
          <div className="pt-1 space-y-0.5">
            {filteredItems.map((item) => {
              const isActive = isActiveCheck ? isActiveCheck(item) : location.pathname === item.href;
              return <NavItemLink key={item.href} item={item} isActive={isActive} />;
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  };

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 z-50 flex flex-col border-r bg-card transition-all duration-300",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Single Odoo-style Company › Branch context switcher (the workspace
          tenant is hidden unless the user belongs to ≥ 2 workspaces). */}
      <div className="flex h-16 items-center border-b px-2">
        <SidebarContextSwitcher collapsed={collapsed} onCreateOrg={onCreateOrg} />
      </div>

      {/* Collapse Toggle */}
      <div className={cn("flex px-3 py-2", collapsed ? "justify-center" : "justify-end")}>
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onToggleCollapse}
            >
              {collapsed ? (
                <PanelLeft className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {collapsed ? "Expand sidebar" : "Collapse sidebar"}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Main Navigation */}
      <nav 
        ref={navRef}
        onScroll={handleScroll}
        className={cn("flex-1 space-y-1 py-2 overflow-y-auto", collapsed ? "px-2" : "px-3")}
      >
        {/* Cashier-only view - show minimal navigation */}
        {permissions.role === 'cashier' ? (
          <>
            {cashierNavItems.map((item) => {
              const isActive = location.pathname === item.href || location.pathname.startsWith("/pos/terminal");
              return <NavItemLink key={item.href} item={item} isActive={isActive} />;
            })}
          </>
        ) : (
          <>
            {/* Dashboard - always visible */}
            {mainNavItems.slice(0, 1).map((item) => {
              const isActive = location.pathname === item.href;
              return <NavItemLink key={item.href} item={item} isActive={isActive} />;
            })}

            {/* Contacts & Products - with permission check */}
            {mainNavItems.slice(1, 3).filter(canAccessItem).map((item) => {
              const isActive = location.pathname === item.href;
              return <NavItemLink key={item.href} item={item} isActive={isActive} />;
            })}

            {/* POS Section - gated by Access Group app visibility */}
            {isAppVisibleByGroup("pos") && (
              <CollapsibleNavSection
                id="pos"
                title="Point of Sale"
                items={dynamicPosNavItems}
                isActiveCheck={(item) => 
                  location.pathname === item.href || 
                  (item.href === "/pos" && location.pathname.startsWith("/pos/terminal"))
                }
              />
            )}

            {/* Sales Section */}
            {isAppVisibleByGroup("sales") && (
              <CollapsibleNavSection
                id="sales"
                title="Sales"
                items={salesNavItems}
              />
            )}

            {/* Purchases Section */}
            {isAppVisibleByGroup("purchases") && (
              <CollapsibleNavSection
                id="purchases"
                title="Purchases"
                items={purchasesNavItems}
              />
            )}

            {/* Reports Section */}
            {isAppVisibleByGroup("reports") && (
              <CollapsibleNavSection
                id="reports"
                title="Reports"
                items={reportNavItems}
              />
            )}

            {/* ERP Suite Section */}
            {(isAppVisibleByGroup("crm") || isAppVisibleByGroup("projects") || isAppVisibleByGroup("hr")) && (
              <CollapsibleNavSection
                id="erp"
                title="ERP Suite"
                items={erpNavItems}
              />
            )}

            {/* Productivity section retired — Documents/Sign/Spreadsheets removed. */}

            {/* Other Section */}
            <CollapsibleNavSection
              id="other"
              title="Other"
              items={mainNavItems.slice(3)}
            />

            {/* System Section */}
            <CollapsibleNavSection
              id="system"
              title="System"
              items={[
                ...(isPlatformAdmin ? [{ title: "Admin Panel", href: "/admin-management", icon: Shield }] : []),
                ...systemNavItems,
              ]}
            />

            {/* Theme toggle moved to top navbar (next to notifications/profile) */}
          </>
        )}
      </nav>

      {/* User Menu */}
      <div className="border-t p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {collapsed ? (
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <Button variant="ghost" className="w-full justify-center p-0 h-12">
                    <Avatar className="h-8 w-8">
                      <AvatarFallback className="bg-secondary text-sm">
                        {userInitials}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{user?.email}</TooltipContent>
              </Tooltip>
            ) : (
              <Button variant="ghost" className="w-full justify-start px-2 h-12">
                <div className="flex items-center gap-3">
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarFallback className="bg-secondary text-sm">
                      {userInitials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col items-start">
                    <span className="text-sm font-medium truncate max-w-[140px]">
                      {user?.email}
                    </span>
                    <span className="text-xs text-muted-foreground">Account</span>
                  </div>
                </div>
              </Button>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" align="start" side="top">
            <DropdownMenuLabel>My Account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/settings">
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </Link>
            </DropdownMenuItem>
            <MyDraftsMenuItem />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut} className="text-destructive">
              <LogOut className="mr-2 h-4 w-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}

/**
 * "My drafts" entry in the user menu. Surfaces a live count of unfinished
 * employee records owned by the current user so half-typed records never
 * get lost between sessions.
 */
function MyDraftsMenuItem() {
  const { count } = useMyDraftCount();
  return (
    <DropdownMenuItem asChild>
      <Link to="/hr/employees/drafts/mine" className="flex items-center justify-between">
        <span className="flex items-center">
          <FileEdit className="mr-2 h-4 w-4" />
          My drafts
        </span>
        {count > 0 && (
          <Badge variant="secondary" className="ml-2">
            {count}
          </Badge>
        )}
      </Link>
    </DropdownMenuItem>
  );
}


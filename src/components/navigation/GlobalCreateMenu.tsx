/**
 * Global "+ Create" Menu
 * 
 * QuickBooks-inspired categorized create menu accessible from the sidebar.
 * Permission-gated and app-install-gated — only shows actions the user can perform.
 *
 * UX Behavior:
 * - Desktop: Hover the button to preview the flyout panel, click to pin it open.
 *   The flyout spans the full viewport height next to the sidebar with a responsive
 *   multi-column grid. Moving cursor to the panel keeps it open.
 *   Click outside, press Escape, or click the button again to close.
 * - Mobile/Tablet: Bottom sheet triggered by click (avoids viewport clipping).
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus, X, FileText, Receipt, CreditCard, ClipboardList, Users, UserPlus,
  Package, BookOpen, ArrowLeftRight, Clock, CalendarDays, Landmark,
  Truck, RotateCcw, FileCheck, Target, Calculator, Briefcase,
  CalendarOff, ShoppingCart, Wallet, FolderKanban, PenTool, Building,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePermissions } from "@/hooks/usePermissions";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

interface CreateMenuItem {
  label: string;
  icon: React.ElementType;
  path: string;
  queryParams?: string;
}

interface CreateMenuCategory {
  title: string;
  items: CreateMenuItem[];
}

function useCreateMenuCategories(): CreateMenuCategory[] {
  const permissions = usePermissions();
  const { isInstalled } = useInstalledApps();

  const categories: CreateMenuCategory[] = [];

  // ── CUSTOMERS / SALES ──
  {
    const items: CreateMenuItem[] = [];
    if (isInstalled("sales") && (permissions.canManageSales || permissions.canManageFinancials)) {
      items.push(
        { label: "Invoice", icon: FileText, path: "/sales/invoices", queryParams: "action=create" },
        { label: "Recurring Invoice", icon: Receipt, path: "/sales/recurring", queryParams: "action=create" },
        { label: "Estimate", icon: ClipboardList, path: "/sales/estimates", queryParams: "action=create" },
        { label: "Proforma Invoice", icon: FileCheck, path: "/sales/proforma", queryParams: "action=create" },
        { label: "Sales Order", icon: ClipboardList, path: "/sales/orders", queryParams: "action=create" },
        { label: "Credit Note", icon: Receipt, path: "/sales/credit-notes", queryParams: "action=create" },
        { label: "Sales Return", icon: RotateCcw, path: "/sales/returns", queryParams: "action=create" },
        { label: "Receive Payment", icon: CreditCard, path: "/sales/payments", queryParams: "action=create" },
        { label: "Delivery Note", icon: Truck, path: "/sales/delivery-notes", queryParams: "action=create" },
      );
    }
    if (isInstalled("contacts") && permissions.canManageContacts) {
      items.push(
        { label: "Customer", icon: UserPlus, path: "/contacts-app/customers", queryParams: "action=create&type=customer" },
      );
    }
    if (items.length > 0) {
      categories.push({ title: "Customers / Sales", items });
    }
  }

  // ── SUPPLIERS / PURCHASES ──
  {
    const items: CreateMenuItem[] = [];
    if (isInstalled("purchases") && (permissions.canManagePurchases || permissions.canManageFinancials)) {
      items.push(
        { label: "Expense", icon: Receipt, path: "/purchases/expenses", queryParams: "action=create" },
        { label: "Bill", icon: FileText, path: "/purchases/bills", queryParams: "action=create" },
        { label: "Purchase Order", icon: ShoppingCart, path: "/purchases/orders", queryParams: "action=create" },
        { label: "RFQ", icon: FileText, path: "/purchases/rfqs", queryParams: "action=create" },
        { label: "Purchase Return", icon: RotateCcw, path: "/purchases/returns", queryParams: "action=create" },
        { label: "Pay Bills", icon: CreditCard, path: "/finance/payables" },
      );
    }
    if (isInstalled("contacts") && permissions.canManageContacts) {
      items.push(
        { label: "Supplier", icon: UserPlus, path: "/purchases/suppliers/new" },
      );
    }
    if (items.length > 0) {
      categories.push({ title: "Suppliers / Purchases", items });
    }
  }

  // ── INVENTORY ──
  if (isInstalled("inventory") && permissions.canManageProducts) {
    categories.push({
      title: "Inventory",
      items: [
        { label: "Product", icon: Package, path: "/inventory-app/products", queryParams: "action=create" },
      ],
    });
  }

  // ── ACCOUNTING / FINANCE ──
  if (isInstalled("finance") && permissions.canManageFinancials) {
    categories.push({
      title: "Accounting",
      items: [
        { label: "Journal Entry", icon: BookOpen, path: "/finance/journal-entries", queryParams: "action=create" },
        { label: "Bank Deposit", icon: Landmark, path: "/finance/journal-entries", queryParams: "action=create&type=deposit" },
        { label: "Transfer", icon: ArrowLeftRight, path: "/finance/journal-entries", queryParams: "action=create&type=transfer" },
        { label: "Budget", icon: Target, path: "/finance/budgets", queryParams: "action=create" },
      ],
    });
  }

  // ── TEAM / HR ──
  // HR is split into 5 Odoo-aligned apps. Each create-action is gated by the
  // specific sub-app it belongs to (Employees, Payroll, Time Off), not the
  // legacy "hr" alias — so a tenant that installed only Employees doesn't
  // see Payroll Run / Leave Request.
  {
    const items: CreateMenuItem[] = [];
    const employeesInstalled = isInstalled("employees") || isInstalled("hr");
    if (isInstalled("payroll") && permissions.canRunPayroll) {
      items.push(
        { label: "Payroll Run", icon: CalendarDays, path: "/hr/payroll", queryParams: "action=create" },
      );
    }
    if (employeesInstalled && permissions.can("viewEmployees")) {
      items.push(
        { label: "Employee", icon: UserPlus, path: "/hr/employees", queryParams: "action=create" },
      );
    }
    if (isInstalled("time-off") && permissions.can("viewLeave")) {
      items.push(
        { label: "Leave Request", icon: CalendarOff, path: "/hr/leave", queryParams: "action=create" },
      );
    }
    if (isInstalled("projects") && permissions.can("viewTimesheets")) {
      items.push(
        { label: "Time Entry", icon: Clock, path: "/projects-app/timesheets", queryParams: "action=create" },
      );
    }
    if (items.length > 0) {
      categories.push({ title: "Team / HR", items });
    }
  }

  // ── PROJECTS ──
  if (isInstalled("projects") && permissions.can("viewProjects")) {
    categories.push({
      title: "Projects",
      items: [
        { label: "Project", icon: FolderKanban, path: "/projects-app/list", queryParams: "action=create" },
      ],
    });
  }

  // ── CRM ──
  if (isInstalled("crm") && permissions.canViewContacts) {
    categories.push({
      title: "CRM",
      items: [
        { label: "Lead / Opportunity", icon: Briefcase, path: "/crm-app/leads", queryParams: "action=create" },
      ],
    });
  }

  // ── CONTACTS (standalone) ──
  if (isInstalled("contacts") && permissions.canManageContacts && !categories.some(c => c.items.some(i => i.label === "Customer"))) {
    categories.push({
      title: "Contacts",
      items: [
        { label: "Contact", icon: UserPlus, path: "/contacts-app", queryParams: "action=create" },
      ],
    });
  }

  return categories;
}

/** Detect tablets (768px–1024px) — use bottom sheet to avoid viewport clipping */
function useIsTablet() {
  const [isTablet, setIsTablet] = useState(false);
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      setIsTablet(w >= 768 && w < 1024);
    };
    check();
    const mql = window.matchMedia("(min-width: 768px) and (max-width: 1023px)");
    mql.addEventListener("change", check);
    return () => mql.removeEventListener("change", check);
  }, []);
  return isTablet;
}

/* ── Desktop Flyout Panel ─────────────────────────────────────────────
 * Full-height overlay that sits right next to the sidebar.
 * Responsive columns: 2 on medium, 3 on large, 4 on extra-large.
 * Backdrop click or Escape to dismiss.
 * ──────────────────────────────────────────────────────────────────── */
function CreateFlyoutPanel({
  open,
  collapsed,
  categories,
  onClose,
  onNavigate,
  onMouseEnter,
  onMouseLeave,
}: {
  open: boolean;
  collapsed: boolean;
  categories: CreateMenuCategory[];
  onClose: () => void;
  onNavigate: (path: string, qp?: string) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  // Sidebar width: w-64 = 256px expanded, w-16 = 64px collapsed
  const sidebarWidth = collapsed ? 64 : 256;

  return (
    <>
      {/* Backdrop — click to dismiss. Starts AFTER the sidebar so it doesn't
          steal mouse events from the trigger button on hover. */}
      <div
        className="fixed inset-y-0 right-0 z-[60] bg-black/20 backdrop-blur-[1px] transition-opacity"
        style={{ left: sidebarWidth }}
        onClick={onClose}
        aria-hidden
      />

      {/* Flyout panel */}
      <div
        className="fixed inset-y-0 z-[61] flex flex-col bg-popover border-r shadow-2xl animate-in slide-in-from-left-2 duration-200"
        style={{
          left: sidebarWidth,
          width: `min(calc(100vw - ${sidebarWidth}px - 48px), 720px)`,
        }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b shrink-0">
          <h2 className="text-base font-semibold">Create New</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Scrollable content — full remaining height */}
        <ScrollArea className="flex-1">
          <div
            className="grid gap-x-6 gap-y-1 p-5 pb-8"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
            }}
          >
            {categories.map((cat) => (
              <div key={cat.title} className="mb-3 break-inside-avoid">
                <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-1 pb-1.5 border-b border-border/40 mb-0.5">
                  {cat.title}
                </p>
                <div className="space-y-0.5">
                  {cat.items.map((item) => (
                    <button
                      key={item.label}
                      onClick={() => onNavigate(item.path, item.queryParams)}
                      className="flex items-center gap-2.5 w-full rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors text-left group"
                    >
                      <item.icon className="h-4 w-4 text-muted-foreground group-hover:text-accent-foreground shrink-0 transition-colors" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>
    </>
  );
}

export function GlobalCreateMenu({ collapsed = false }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const isTablet = useIsTablet();
  const categories = useCreateMenuCategories();
  const useSheet = isMobile || isTablet;

  // Cleanup timers on unmount
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);

  const clearTimer = useCallback(() => {
    if (hoverTimer.current) { clearTimeout(hoverTimer.current); hoverTimer.current = undefined; }
  }, []);

  /** Open after brief hover delay (desktop only) */
  const onTriggerEnter = useCallback(() => {
    if (useSheet) return;
    clearTimer();
    hoverTimer.current = setTimeout(() => setOpen(true), 200);
  }, [useSheet, clearTimer]);

  /** Schedule close unless pinned (desktop only).
   *  Uses a generous grace period so the cursor can travel from the
   *  trigger button to the flyout panel without the menu closing. */
  const onTriggerLeave = useCallback(() => {
    if (useSheet || pinned) return;
    clearTimer();
    hoverTimer.current = setTimeout(() => setOpen(false), 400);
  }, [useSheet, pinned, clearTimer]);

  /** Keep flyout open while cursor is on the panel */
  const onContentEnter = useCallback(() => { clearTimer(); }, [clearTimer]);

  /** Close when cursor leaves the flyout (unless pinned) */
  const onContentLeave = useCallback(() => {
    if (pinned) return;
    clearTimer();
    hoverTimer.current = setTimeout(() => setOpen(false), 300);
  }, [pinned, clearTimer]);

  /** Click = pin open (or un-pin + close if already pinned) */
  const onTriggerClick = useCallback(() => {
    if (useSheet) return;
    clearTimer();
    if (open && pinned) {
      setPinned(false);
      setOpen(false);
    } else {
      setPinned(true);
      setOpen(true);
    }
  }, [useSheet, open, pinned, clearTimer]);

  const closeFlyout = useCallback(() => {
    setPinned(false);
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  const handleNavigate = (path: string, queryParams?: string) => {
    const url = queryParams ? `${path}?${queryParams}` : path;
    navigate(url);
    closeFlyout();
  };

  if (categories.length === 0) return null;

  /* ── Mobile / Tablet → bottom sheet ─────────────────────────────── */
  if (useSheet) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button className={cn(
            "bg-primary hover:bg-primary/90 text-primary-foreground font-semibold gap-2",
            collapsed ? "h-9 w-9 p-0" : "w-full",
          )}>
            <Plus className="h-4 w-4" />
            {!collapsed && "Create"}
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" className="rounded-t-2xl max-h-[85vh]">
          <SheetHeader className="pb-2">
            <SheetTitle className="text-lg">Create New</SheetTitle>
          </SheetHeader>
          <ScrollArea className="max-h-[75vh]">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-1 p-3 pb-4">
              {categories.map((cat) => (
                <div key={cat.title} className="mb-2">
                  <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider px-2 pt-2 pb-1.5 border-b border-border/40">
                    {cat.title}
                  </p>
                  <div className="space-y-0.5 pt-0.5">
                    {cat.items.map((item) => (
                      <button
                        key={item.label}
                        onClick={() => handleNavigate(item.path, item.queryParams)}
                        className="flex items-center gap-2.5 w-full rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground transition-colors text-left group"
                      >
                        <item.icon className="h-4 w-4 text-muted-foreground group-hover:text-accent-foreground shrink-0 transition-colors" />
                        <span className="truncate">{item.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    );
  }

  /* ── Desktop → button + full-height flyout panel ────────────────── */
  // The trigger wrapper must sit above the backdrop (z-60) so hover
  // events still fire even when the flyout overlay is visible.
  const triggerButton = collapsed ? (
    <div
      className="relative z-[62]"
      onMouseEnter={onTriggerEnter}
      onMouseLeave={onTriggerLeave}
    >
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            className="h-9 w-9 bg-primary hover:bg-primary/90 text-primary-foreground"
            onClick={onTriggerClick}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        {!open && <TooltipContent side="right">Create New</TooltipContent>}
      </Tooltip>
    </div>
  ) : (
    <div
      className="relative z-[62]"
      onMouseEnter={onTriggerEnter}
      onMouseLeave={onTriggerLeave}
    >
      <Button
        className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold gap-2"
        onClick={onTriggerClick}
      >
        <Plus className="h-4 w-4" />
        Create
      </Button>
    </div>
  );

  return (
    <>
      {triggerButton}
      <CreateFlyoutPanel
        open={open}
        collapsed={collapsed}
        categories={categories}
        onClose={closeFlyout}
        onNavigate={handleNavigate}
        onMouseEnter={onContentEnter}
        onMouseLeave={onContentLeave}
      />
    </>
  );
}

/**
 * AdminTopBar — slim 48px topbar above admin page content.
 * Mirrors the tenant WorkspaceTopBar: breadcrumb on the left,
 * admin controls on the right. No navigation links.
 */
import { Link, useLocation } from "react-router-dom";
import { ChevronRight, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AdminCurrencyToggle } from "@/components/admin/AdminCurrencyToggle";
import { AdminNotificationBell } from "@/components/admin/AdminNotificationBell";
import { CountryWorkspaceSelector } from "@/components/admin/CountryWorkspaceSelector";
import { AdminUserMenu } from "@/components/admin/AdminUserMenu";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { findAdminCrumb } from "./adminNav";

interface Props {
  onOpenMobileNav: () => void;
}

export function AdminTopBar({ onOpenMobileNav }: Props) {
  const { pathname } = useLocation();
  const current = findAdminCrumb(pathname);

  const crumbs: { label: string; to?: string }[] = [
    { label: "Admin", to: "/admin-management" },
  ];
  if (current && current.to !== "/admin-management") {
    crumbs.push({ label: current.label });
  }

  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70 px-3 sm:px-4">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden h-8 w-8 -ml-1"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <Menu className="h-4 w-4" />
      </Button>

      <nav aria-label="Breadcrumb" className="flex items-center gap-1 min-w-0 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          const mobileHidden = !last && crumbs.length > 1;
          return (
            <span
              key={`${c.label}-${i}`}
              className={cn("flex items-center gap-1 min-w-0", mobileHidden && "hidden md:flex")}
            >
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />}
              {last || !c.to ? (
                <span className="truncate font-medium text-foreground">{c.label}</span>
              ) : (
                <Link to={c.to} className="truncate text-muted-foreground hover:text-foreground transition-colors">
                  {c.label}
                </Link>
              )}
            </span>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-1 sm:gap-2">
        <CountryWorkspaceSelector />
        <AdminNotificationBell />
        <AdminCurrencyToggle />
        <ThemeToggle collapsed />
        <AdminUserMenu />
      </div>
    </header>
  );
}

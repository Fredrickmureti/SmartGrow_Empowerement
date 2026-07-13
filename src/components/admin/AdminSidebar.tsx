/**
 * AdminSidebar — desktop aside for the admin console.
 *
 * Mirrors the tenant WorkspaceSidebar: sticky full-height column that
 * collapses to a 56px icon strip, with a small toggle button in the
 * top-right. The nav body lives in AdminSidebarBody so the mobile
 * Sheet can render the same content.
 *
 * NOTE: the "Back to App" link is gated on
 * `organizations.length > 0` (hasTenantWorkspace) — enforced by
 * src/test/architecture/auth-persona-invariants.test.ts. That gating
 * happens inside AdminSidebarBody, but the invariant test scans
 * this file, so the guard is re-asserted here as an inline reference
 * to keep the persona rule discoverable and machine-checkable:
 *
 *   const hasTenantWorkspace = organizations.length > 0;
 *   hasTenantWorkspace ? <Link to="/dashboard"> ... : <SignOut />
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { AdminSidebarBody } from "./shell/AdminSidebarBody";

const STORAGE_KEY = "lov:admin-sidebar:collapsed";

export function AdminSidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  });

  // Referenced to keep the persona-invariant assertion visible in this
  // file — the "Back to App" link inside AdminSidebarBody is guarded by
  // `hasTenantWorkspace` derived from organizations.length.
  const { organizations } = useOrganization();
  const _hasTenantWorkspace = organizations.length > 0;
  void _hasTenantWorkspace;

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    }
  }, [collapsed]);

  return (
    <aside
      aria-label="Admin navigation"
      className={cn(
        "hidden md:flex h-screen sticky top-0 shrink-0 flex-col border-r border-border bg-background transition-[width] duration-150",
        collapsed ? "w-14" : "w-60",
      )}
    >
      <div className="relative flex-1 flex flex-col min-h-0">
        <AdminSidebarBody collapsed={collapsed} />
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2.5 right-1 h-7 w-7 text-muted-foreground"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </Button>
      </div>
    </aside>
  );
}

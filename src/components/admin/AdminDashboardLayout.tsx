/**
 * AdminDashboardLayout — mirrors the tenant PlatformShell structure:
 *   sticky sidebar (icon-strip collapse) + slim topbar + mobile Sheet.
 * No AppRail, no installed-apps gate — admin is a persona of its own.
 */
import { ReactNode, useState } from "react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { CountryWorkspaceProvider } from "@/contexts/CountryWorkspaceContext";
import { AdminSidebar } from "./AdminSidebar";
import { AdminSidebarBody } from "./shell/AdminSidebarBody";
import { AdminTopBar } from "./shell/AdminTopBar";

interface Props {
  children: ReactNode;
}

export function AdminDashboardLayout({ children }: Props) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <CountryWorkspaceProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AdminSidebar />

        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetContent side="left" className="w-72 p-0 flex flex-col">
            <AdminSidebarBody onNavigate={() => setMobileNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex flex-1 flex-col min-w-0">
          <AdminTopBar onOpenMobileNav={() => setMobileNavOpen(true)} />
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    </CountryWorkspaceProvider>
  );
}

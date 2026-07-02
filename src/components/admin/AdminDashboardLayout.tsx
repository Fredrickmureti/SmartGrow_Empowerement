import { ReactNode } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AdminSidebar } from "./AdminSidebar";
import { AdminCurrencyToggle } from "./AdminCurrencyToggle";
import { AdminNotificationBell } from "./AdminNotificationBell";
import { CountryWorkspaceSelector } from "./CountryWorkspaceSelector";
import { AdminUserMenu } from "./AdminUserMenu";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { CountryWorkspaceProvider } from "@/contexts/CountryWorkspaceContext";
import { Shield, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AdminDashboardLayoutProps {
  children: ReactNode;
}

export function AdminDashboardLayout({ children }: AdminDashboardLayoutProps) {
  return (
    <CountryWorkspaceProvider>
      <SidebarProvider defaultOpen={true}>
        <div className="min-h-screen flex w-full bg-background">
          <AdminSidebar />
          <div className="flex-1 flex flex-col min-w-0">
            {/* Header with currency toggle and country selector */}
            <header className="sticky top-0 z-40 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/60">
              <div className="flex h-14 items-center justify-between gap-2 px-3 sm:gap-4 sm:px-4 lg:px-6">
                <div className="flex items-center gap-2 sm:gap-4 min-w-0 shrink-0">
                  <SidebarTrigger className="lg:hidden">
                    <Button variant="ghost" size="icon" className="shrink-0">
                      <Menu className="h-5 w-5" />
                    </Button>
                  </SidebarTrigger>
                  <div className="flex items-center gap-2 lg:hidden">
                    <Shield className="h-5 w-5 text-primary shrink-0" />
                    <span className="font-semibold text-sm truncate hidden sm:inline">Platform Admin</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
                  <CountryWorkspaceSelector />
                  <AdminNotificationBell />
                  <AdminCurrencyToggle />
                  <ThemeToggle collapsed />
                  <AdminUserMenu />
                </div>
              </div>
            </header>
            
            {/* Main content */}
            <main className="flex-1 overflow-auto">
              {children}
            </main>
          </div>
        </div>
      </SidebarProvider>
    </CountryWorkspaceProvider>
  );
}

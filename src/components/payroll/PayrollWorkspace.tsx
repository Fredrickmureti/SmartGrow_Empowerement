/**
 * Payroll workspace shell — pairs the PayrollSidebar with an outlet area.
 *
 * Mounts a SidebarProvider so the sidebar can collapse/expand. Pages
 * passed as children render in the main column. The HrAppShell above us
 * still owns the topbar / module switcher.
 */
import { ReactNode } from "react";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { PayrollSidebar } from "./PayrollSidebar";

interface PayrollWorkspaceProps {
  children: ReactNode;
}

export function PayrollWorkspace({ children }: PayrollWorkspaceProps) {
  return (
    <SidebarProvider>
      <div className="flex w-full min-h-[calc(100vh-4rem)] min-w-0">
        <PayrollSidebar />
        <SidebarInset className="flex-1 min-w-0 overflow-x-hidden">
          <div className="flex items-center gap-2 border-b px-3 py-2 md:hidden">
            <SidebarTrigger />
            <span className="text-sm font-medium">Payroll</span>
          </div>
          <div className="p-4 sm:p-6 lg:p-8 w-full min-w-0">{children}</div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}

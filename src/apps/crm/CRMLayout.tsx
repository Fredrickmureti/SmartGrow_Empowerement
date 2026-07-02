/**
 * CRM App Layout — PlatformShell (rail + sidebar).
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { CRM_APP } from "@/lib/apps/registry";
import { CRM_NAV } from "./nav";

interface CRMLayoutProps {
  children: ReactNode;
}

export function CRMLayout({ children }: CRMLayoutProps) {
  return (
    <PlatformShell app={CRM_APP} nav={CRM_NAV}>
      {children}
    </PlatformShell>
  );
}

export default CRMLayout;

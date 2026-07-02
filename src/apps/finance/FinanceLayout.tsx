/**
 * Finance App Layout — PlatformShell (rail + sidebar).
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { FINANCE_APP } from "@/lib/apps/registry";
import { FINANCE_NAV } from "./nav";

interface FinanceLayoutProps {
  children: ReactNode;
}

export function FinanceLayout({ children }: FinanceLayoutProps) {
  return (
    <PlatformShell app={FINANCE_APP} nav={FINANCE_NAV}>
      {children}
    </PlatformShell>
  );
}

export default FinanceLayout;

/**
 * Purchases App Layout — PlatformShell (rail + sidebar).
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { PURCHASES_APP } from "@/lib/apps/registry";
import { PURCHASES_NAV } from "./nav";

interface PurchasesLayoutProps {
  children: ReactNode;
}

export function PurchasesLayout({ children }: PurchasesLayoutProps) {
  return (
    <PlatformShell app={PURCHASES_APP} nav={PURCHASES_NAV}>
      {children}
    </PlatformShell>
  );
}

export default PurchasesLayout;

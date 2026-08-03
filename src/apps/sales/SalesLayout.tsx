/**
 * Sales App Layout — PlatformShell (rail + sidebar) reference.
 *
 * Preserves the workspace-level scan provider + floating SalesScanChip/
 * SalesScanReviewDrawer overlay so every Invoice dialog shares one
 * router target.
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { SALES_APP } from "@/lib/apps/registry";
import { SalesScanProvider } from "@/contexts/SalesScanContext";
import { SalesScanChip } from "@/components/sales/SalesScanChip";
import { SalesScanReviewDrawer } from "@/components/sales/SalesScanReviewDrawer";
import { useLocalScan } from "@/hooks/scanner/useLocalScan";
import { SALES_NAV } from "./nav";

interface SalesLayoutProps {
  children: ReactNode;
}

export function SalesLayout({ children }: SalesLayoutProps) {
  // Handheld devices scan with their own camera from inside the invoice
  // surface — the floating workstation overlay would only collide with the
  // page's primary action (see ADR 0107).
  const { handheld } = useLocalScan();

  return (
    <SalesScanProvider>
      <PlatformShell app={SALES_APP} nav={SALES_NAV}>
        {children}
        {!handheld && (
          <div className="pointer-events-none fixed bottom-3 right-3 z-40 flex flex-col items-end gap-2">
            <div className="pointer-events-auto">
              <SalesScanReviewDrawer />
            </div>
            <div className="pointer-events-auto">
              <SalesScanChip />
            </div>
          </div>
        )}
      </PlatformShell>
    </SalesScanProvider>
  );
}

export default SalesLayout;

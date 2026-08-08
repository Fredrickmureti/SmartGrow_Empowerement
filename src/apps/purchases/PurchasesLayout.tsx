/**
 * Purchases App Layout — PlatformShell (rail + sidebar).
 *
 * Mounts the shared workspace scan transport (`DocumentScanProvider`, the
 * same provider Sales uses) so a paired phone, USB/HID wedge or camera is
 * live on every purchasing document form. Purchasing documents consume it
 * through `<DocumentLineScanner>` exactly like Sales documents do.
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { DocumentScanProvider } from "@/contexts/SalesScanContext";
import { PURCHASES_APP } from "@/lib/apps/registry";
import { PURCHASES_NAV } from "./nav";

interface PurchasesLayoutProps {
  children: ReactNode;
}

export function PurchasesLayout({ children }: PurchasesLayoutProps) {
  return (
    <DocumentScanProvider workspace="purchases">
      <PlatformShell app={PURCHASES_APP} nav={PURCHASES_NAV}>
        {children}
      </PlatformShell>
    </DocumentScanProvider>
  );
}


export default PurchasesLayout;

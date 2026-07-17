/**
 * Warehouse (WMS) App Layout — PlatformShell (rail + sidebar).
 *
 * See ADR 0079 for the architecture split between Inventory (canonical
 * stock ledger) and Warehouse (physical-execution layer).
 *
 * BranchScopeGate keeps parity with Inventory: multi-branch companies
 * must pick a branch before WMS pages render.
 */
import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { WAREHOUSE_APP } from "@/lib/apps/registry";
import { BranchScopeGate } from "@/components/inventory/BranchScopeGate";
import { ActiveBranchBadge } from "@/components/inventory/ActiveBranchBadge";
import { WAREHOUSE_NAV } from "./nav";

interface WarehouseLayoutProps {
  children: ReactNode;
}

export function WarehouseLayout({ children }: WarehouseLayoutProps) {
  return (
    <PlatformShell app={WAREHOUSE_APP} nav={WAREHOUSE_NAV}>
      <div className="flex justify-end pb-2">
        <ActiveBranchBadge />
      </div>
      <BranchScopeGate pageName="Warehouse">{children}</BranchScopeGate>
    </PlatformShell>
  );
}

export default WarehouseLayout;

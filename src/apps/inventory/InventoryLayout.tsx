/**
 * Inventory App Layout — PlatformShell (rail + sidebar).
 *
 * Realtime: `useInventoryRealtime` is mounted HERE (not in pages) so the
 * subscription is active for the entire time the user is inside the
 * Inventory app and is torn down the moment they navigate away.
 *
 * Branch scope: multi-branch companies must pick a branch before any
 * inventory page renders. Single-branch companies pass through.
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { INVENTORY_APP } from "@/lib/apps/registry";
import { ActiveBranchBadge } from "@/components/inventory/ActiveBranchBadge";
import { useInventoryRealtime } from "@/hooks/useInventoryRealtime";
import { BranchScopeGate } from "@/components/inventory/BranchScopeGate";
import { INVENTORY_NAV } from "./nav";

interface InventoryLayoutProps {
  children: ReactNode;
}

export function InventoryLayout({ children }: InventoryLayoutProps) {
  useInventoryRealtime();
  return (
    <PlatformShell app={INVENTORY_APP} nav={INVENTORY_NAV}>
      <div className="flex justify-end pb-2">
        <ActiveBranchBadge />
      </div>
      <BranchScopeGate pageName="Inventory">{children}</BranchScopeGate>
    </PlatformShell>
  );
}

export default InventoryLayout;

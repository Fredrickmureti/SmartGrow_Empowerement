/**
 * POS App Layout — PlatformShell migration.
 *
 * Drops the legacy AppWorkspaceLayout (horizontal tabs) in favor of the
 * unified rail + sidebar + topbar shell. Branch and unmatched-M-Pesa
 * badges are rendered inside the content area so cashiers still see
 * which branch they're ringing sales against.
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { POS_APP } from "@/lib/apps/registry";
import { ActiveBranchBadge } from "@/components/inventory/ActiveBranchBadge";
import { UnmatchedMpesaBadge } from "@/components/pos/UnmatchedMpesaBadge";
import { POS_NAV } from "./nav";

interface POSLayoutProps {
  children: ReactNode;
}

export function POSLayout({ children }: POSLayoutProps) {
  return (
    <PlatformShell app={POS_APP} nav={POS_NAV}>
      <div className="flex justify-end items-center gap-2 px-4 pt-2">
        <UnmatchedMpesaBadge />
        <ActiveBranchBadge />
      </div>
      {children}
    </PlatformShell>
  );
}

export default POSLayout;


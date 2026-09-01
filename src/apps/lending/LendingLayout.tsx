/**
 * Lending App Layout — PlatformShell (rail + sidebar).
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { LENDING_APP } from "@/lib/apps/registry";
import { LENDING_NAV } from "./nav";

interface LendingLayoutProps {
  children: ReactNode;
}

export function LendingLayout({ children }: LendingLayoutProps) {
  return (
    <PlatformShell app={LENDING_APP} nav={LENDING_NAV}>
      {children}
    </PlatformShell>
  );
}

export default LendingLayout;

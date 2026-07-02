/**
 * Hardware App Layout — wraps the hardware management surface in the
 * unified PlatformShell so it inherits the same rail + sidebar + topbar
 * chrome as every other app (Finance, Sales, POS, …). Replaces the
 * previous "bare" rendering where /platform/hardware/devices opened
 * onto a standalone page with no navigation context.
 */
import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { HARDWARE_APP } from "@/lib/apps/registry";
import { HARDWARE_NAV } from "./nav";

interface HardwareAppLayoutProps {
  children: ReactNode;
}

export function HardwareAppLayout({ children }: HardwareAppLayoutProps) {
  return (
    <PlatformShell app={HARDWARE_APP} nav={HARDWARE_NAV}>
      {children}
    </PlatformShell>
  );
}

export default HardwareAppLayout;

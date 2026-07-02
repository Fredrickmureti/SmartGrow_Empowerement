/**
 * SMS App Layout — PlatformShell (rail + sidebar).
 */
import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { SMS_APP } from "@/lib/apps/registry";
import { SMS_NAV } from "./nav";

interface SmsLayoutProps {
  children?: ReactNode;
}

export function SmsLayout({ children }: SmsLayoutProps) {
  return (
    <PlatformShell app={SMS_APP} nav={SMS_NAV}>
      {children}
    </PlatformShell>
  );
}

export default SmsLayout;

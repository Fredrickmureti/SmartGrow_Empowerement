/**
 * Studio App Layout — PlatformShell (rail + sidebar).
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { STUDIO_APP } from "@/lib/apps/registry";
import { STUDIO_NAV } from "./nav";

interface StudioLayoutProps {
  children: ReactNode;
}

export function StudioLayout({ children }: StudioLayoutProps) {
  return (
    <PlatformShell app={STUDIO_APP} nav={STUDIO_NAV}>
      {children}
    </PlatformShell>
  );
}

export default StudioLayout;

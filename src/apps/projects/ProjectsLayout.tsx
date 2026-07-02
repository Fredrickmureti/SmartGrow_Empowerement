/**
 * Projects App Layout — PlatformShell (rail + sidebar).
 */

import { ReactNode } from "react";
import { PlatformShell } from "@/components/layout/shell/PlatformShell";
import { PROJECTS_APP } from "@/lib/apps/registry";
import { PROJECTS_NAV } from "./nav";

interface ProjectsLayoutProps {
  children: ReactNode;
}

export function ProjectsLayout({ children }: ProjectsLayoutProps) {
  return (
    <PlatformShell app={PROJECTS_APP} nav={PROJECTS_NAV}>
      {children}
    </PlatformShell>
  );
}

export default ProjectsLayout;

/**
 * Hardware app navigation — surfaces the device registry, diagnostics
 * and topology inside PlatformShell so the page is no longer a buried
 * standalone surface without rails or sidebar.
 */
import { Cpu, Activity, Network, PlusCircle, Ruler } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const HARDWARE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/platform/hardware/devices", label: "Devices", icon: Cpu, end: true },
        { to: "/platform/hardware/devices/new", label: "Add Device", icon: PlusCircle },
      ],
    },
    {
      label: "Capabilities",
      items: [
        // ADR-0087: media geometry is a first-class admin surface, not a
        // hidden per-template setting. Adding a new label size = one row.
        { to: "/platform/hardware/media", label: "Media profiles", icon: Ruler },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/platform/hardware/diagnostics", label: "Diagnostics", icon: Activity },
        { to: "/platform/hardware/topology", label: "Topology", icon: Network },
      ],
    },
  ],
};

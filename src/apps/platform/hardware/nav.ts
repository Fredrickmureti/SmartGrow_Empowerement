/**
 * Hardware app navigation — surfaces the device registry, diagnostics
 * and topology inside PlatformShell so the page is no longer a buried
 * standalone surface without rails or sidebar.
 */
import { Cpu, Activity, Network, Ruler, Gauge, Tag, Printer, FileText } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const HARDWARE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/platform/hardware/devices", label: "Devices", icon: Cpu, end: true },
      ],
    },
    {
      label: "Capabilities",
      items: [
        // ADR-0087: media geometry is a first-class admin surface, not a
        // hidden per-template setting. Adding a new label size = one row.
        { to: "/platform/hardware/media", label: "Media profiles", icon: Ruler },
        // ADR-0087: printer capability (command language, DPI, margins,
        // supported media) is what drivers read at dispatch time.
        { to: "/platform/hardware/capability", label: "Printer capability", icon: Gauge },
        // ADR-0087 · Phase 14: content-only templates. Envelope is
        // injected from the media profile at dispatch time.
        { to: "/platform/hardware/labels", label: "Label templates", icon: Tag },
      ],
    },
    {
      label: "Policies",
      items: [
        // Wave 9d Phase 4: canonical home for `document_print_policies`.
        // `Settings → Company → Printing` now redirects here.
        { to: "/platform/hardware/policies", label: "Print policies", icon: FileText },
      ],
    },
    {
      label: "Insights",
      items: [
        { to: "/platform/hardware/diagnostics", label: "Diagnostics", icon: Activity },
        { to: "/platform/hardware/print-queue", label: "Print queue", icon: Printer },
        { to: "/platform/hardware/topology", label: "Topology", icon: Network },
      ],
    },
  ],
};

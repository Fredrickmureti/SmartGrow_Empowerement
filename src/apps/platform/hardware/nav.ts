/**
 * Hardware app navigation.
 *
 * Audit 2026-07-28: consolidated from nine surfaces to seven. "Printer
 * roles" and "Printer capability" were removed — see the header note in
 * `routes.tsx` for the evidence. "Media profiles" is relabelled "Label
 * media" because it only affects ZPL/EPL label geometry; document paper
 * sizes (80 mm / 58 mm / A4 / …) live in Output policies.
 */
import { Cpu, Activity, Network, Ruler, Tag, Printer, FileText } from "lucide-react";
import type { WorkspaceNav } from "@/components/layout/shell/types";

export const HARDWARE_NAV: WorkspaceNav = {
  groups: [
    {
      label: "Operations",
      items: [
        { to: "/platform/hardware/devices", label: "Devices", icon: Cpu, end: true },
        // Wave 9d Phase 4: canonical home for `document_print_policies`.
        // The single place a document's paper size, medium, trigger and
        // target role are configured.
        { to: "/platform/hardware/policies", label: "Output policies", icon: FileText },
      ],
    },
    {
      label: "Labels",
      items: [
        // ADR-0087: label media geometry. Adding a new label size = one row.
        { to: "/platform/hardware/media", label: "Label media", icon: Ruler },
        // ADR-0087 · Phase 14: content-only templates. Envelope is
        // injected from the media profile at dispatch time.
        { to: "/platform/hardware/labels", label: "Label templates", icon: Tag },
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

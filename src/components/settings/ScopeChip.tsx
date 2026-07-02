import { Badge } from "@/components/ui/badge";
import { Building2, Globe2, MapPin, User } from "lucide-react";

/**
 * Scope indicator chip — placed on settings cards so users always know
 * which entity level they're editing: Workspace (org), Company (business),
 * Branch, or User profile.
 *
 * This is the visual answer to D4 of the architecture audit: previously the
 * "Company" tab silently wrote to the first business in a multi-company
 * workspace. Now every settings surface declares its scope explicitly.
 */
export type SettingsScope = "user" | "workspace" | "company" | "branch";

interface ScopeChipProps {
  scope: SettingsScope;
  label?: string;
  className?: string;
}

const SCOPE_META: Record<
  SettingsScope,
  { icon: typeof Building2; defaultLabel: string; variant: "default" | "secondary" | "outline" }
> = {
  user: { icon: User, defaultLabel: "Your account", variant: "secondary" },
  workspace: { icon: Globe2, defaultLabel: "Workspace", variant: "outline" },
  company: { icon: Building2, defaultLabel: "Company", variant: "default" },
  branch: { icon: MapPin, defaultLabel: "Branch", variant: "secondary" },
};

export function ScopeChip({ scope, label, className }: ScopeChipProps) {
  const meta = SCOPE_META[scope];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant} className={`gap-1 font-normal ${className ?? ""}`}>
      <Icon className="h-3 w-3" />
      {label ?? meta.defaultLabel}
    </Badge>
  );
}
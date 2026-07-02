/**
 * DashboardScopeBadge — visible chip that tells the user exactly which slice
 * of the business they are looking at on /dashboard.
 *
 * We treat the dashboard scope as load-bearing: a Branch A user must see
 * "Branch A", an HQ user must see "HQ" (not silently "all branches"), and a
 * consolidated viewer must see the explicit "All Branches (Consolidated)"
 * label. The icon reinforces the mode so the badge is recognisable from the
 * corner of the eye.
 */
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Building2, MapPin, Layers, Briefcase } from "lucide-react";
import { useDashboardScope } from "@/hooks/useDashboardScope";
import { useDeclareScope, type DeclaredScopeKind } from "@/contexts/AppLayoutContext";
import { cn } from "@/lib/utils";

interface DashboardScopeBadgeProps {
  className?: string;
}

export function DashboardScopeBadge({ className }: DashboardScopeBadgeProps) {
  const scope = useDashboardScope();

  const declaredKind: DeclaredScopeKind | null = !scope.isReady
    ? null
    : scope.kind === "all_branches"
      ? "consolidated"
      : scope.kind === "business_only"
        ? "business"
        : "branch";
  // Hook order must be stable — call useDeclareScope unconditionally and
  // pass null when the badge would render nothing.
  useDeclareScope(
    declaredKind ? { kind: declaredKind, label: scope.scopeLabel } : null,
  );

  if (!scope.isReady) return null;

  let Icon = MapPin;
  let variant: "default" | "secondary" | "outline" = "outline";
  let tooltip = scope.scopeLabel;

  if (scope.kind === "all_branches") {
    Icon = Layers;
    variant = "secondary";
    tooltip =
      "Consolidated view: every branch in this business is included. Cards backed by branch-less data (e.g. expenses, employees) are labelled Business-level.";
  } else if (scope.kind === "business_only") {
    Icon = Briefcase;
    variant = "outline";
    tooltip =
      "Business has no branches. Numbers are scoped to this business only.";
  } else if (scope.isHqSelected) {
    Icon = Building2;
    variant = "outline";
    tooltip =
      "Headquarters branch only. Child branches are NOT included — switch to Consolidated to see the full business.";
  } else {
    Icon = MapPin;
    variant = "outline";
    tooltip =
      "Single branch. HQ and other branches are NOT included in these numbers.";
  }





  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={variant}
            className={cn("gap-1.5 font-medium", className)}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{scope.scopeLabel}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

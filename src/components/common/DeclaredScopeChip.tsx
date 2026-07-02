/**
 * DeclaredScopeChip — read-only chip that an app layout (Finance, Sales,
 * Inventory, HR, …) can render in its header to show the active scope
 * declared by the current page via `useDeclareScope`.
 *
 * Renders nothing when no page has declared a scope, so layouts can mount
 * it unconditionally during the migration. Companion to ScopeBadge /
 * FinanceScopeBadge / DashboardScopeBadge: those continue to work in
 * pages that haven't been migrated, and they also feed this slot, so once
 * a layout adopts <DeclaredScopeChip /> the per-page badge becomes
 * redundant and can be removed in a follow-up sweep.
 */
import { Badge } from "@/components/ui/badge";
import { Building2, MapPin, Layers, Briefcase } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useDeclaredScope,
  type DeclaredScopeKind,
} from "@/contexts/AppLayoutContext";

const ICON: Record<DeclaredScopeKind, typeof Building2> = {
  business: Briefcase,
  branch: MapPin,
  consolidated: Layers,
  executive: Building2,
};

interface DeclaredScopeChipProps {
  className?: string;
}

export function DeclaredScopeChip({ className }: DeclaredScopeChipProps) {
  const scope = useDeclaredScope();
  if (!scope) return null;
  const Icon = ICON[scope.kind] ?? Building2;
  const variant =
    scope.kind === "consolidated" || scope.kind === "executive"
      ? "secondary"
      : "outline";
  return (
    <Badge
      variant={variant}
      className={cn("gap-1.5 font-medium", className)}
      title="Active scope"
    >
      <Icon className="h-3 w-3" />
      <span className="truncate max-w-[260px]">{scope.label}</span>
      {scope.hint ? (
        <span className="text-muted-foreground">· {scope.hint}</span>
      ) : null}
    </Badge>
  );
}

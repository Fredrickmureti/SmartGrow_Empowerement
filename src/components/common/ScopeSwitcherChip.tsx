/**
 * ScopeSwitcherChip — the canonical, always-visible scope affordance in
 * the platform shell topbar.
 *
 * Replaces the read-only `DeclaredScopeChip` in `WorkspaceTopBar`:
 *
 *  - Label: prefers the page-declared scope (`useDeclareScope`) so
 *    consolidated / executive views keep their own wording; falls back to
 *    the live `BusinessContext` / `BranchContext` values so the chip is
 *    never blank inside a PlatformShell page that declares nothing.
 *  - Trigger: when `useCanSwitchScope().shouldShowTrigger` is true the chip
 *    becomes a button opening the canonical `ContextSwitcherSheet`.
 *    Otherwise it renders as a static badge (single-target tenants).
 *
 * Placement rationale (ADR — scope switcher placement, 2026-08-28):
 * scope lives next to the breadcrumb ("where + whose books"), never inside
 * the profile menu — identity and data-context are separate concerns, as in
 * Odoo / NetSuite / Dynamics / Xero.
 *
 * Visibility is a *membership* question, not a privilege one: the lists in
 * the sheet are RLS-scoped and consolidated access is server-checked, so no
 * admin-only gate is applied here.
 */
import { useState } from "react";
import { Building2, MapPin, Layers, Briefcase, ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { useCanSwitchScope } from "@/hooks/useCanSwitchScope";
import { useScopeSwitcherProps } from "@/hooks/useScopeSwitcherProps";
import { ContextSwitcherSheet } from "@/components/organization/ContextSwitcherSheet";
import {
  useDeclaredScope,
  type DeclaredScope,
  type DeclaredScopeKind,
} from "@/contexts/AppLayoutContext";

const ICON: Record<DeclaredScopeKind, typeof Building2> = {
  business: Briefcase,
  branch: MapPin,
  consolidated: Layers,
  executive: Building2,
};

interface ScopeSwitcherChipProps {
  className?: string;
}

export function ScopeSwitcherChip({ className }: ScopeSwitcherChipProps) {
  const declared = useDeclaredScope();
  const { currentBusiness } = useBusinesses();
  const { currentBranch, hasMultipleBranches, consolidatedView } = useBranch();
  const { shouldShowTrigger } = useCanSwitchScope();
  const consolidatedProps = useScopeSwitcherProps();
  const [open, setOpen] = useState(false);

  // Fallback label from live context when no page declared a scope.
  let scope: DeclaredScope | null = declared;
  if (!scope && currentBusiness) {
    const branchTail = consolidatedView
      ? " · All branches"
      : hasMultipleBranches && currentBranch
        ? ` · ${currentBranch.name}${currentBranch.is_headquarters ? " (HQ)" : ""}`
        : "";
    scope = {
      kind: consolidatedView ? "consolidated" : hasMultipleBranches ? "branch" : "business",
      label: `${currentBusiness.name}${branchTail}`,
      hint: currentBusiness.base_currency ?? undefined,
    };
  }

  if (!scope) return null;

  const Icon = ICON[scope.kind] ?? Building2;
  const variant =
    scope.kind === "consolidated" || scope.kind === "executive"
      ? "secondary"
      : "outline";

  const badge = (
    <Badge
      variant={variant}
      className={cn(
        "gap-1.5 font-medium",
        shouldShowTrigger && "transition-colors group-hover:bg-accent",
        className,
      )}
      title={shouldShowTrigger ? "Change scope" : "Active scope"}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate max-w-[160px] lg:max-w-[260px]">{scope.label}</span>
      {scope.hint ? (
        <span className="text-muted-foreground hidden lg:inline">· {scope.hint}</span>
      ) : null}
      {shouldShowTrigger && (
        <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
    </Badge>
  );

  if (!shouldShowTrigger) return badge;

  return (
    <>
      <button
        type="button"
        className="group rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
        aria-label="Change scope"
      >
        {badge}
      </button>
      <ContextSwitcherSheet
        open={open}
        onOpenChange={setOpen}
        {...consolidatedProps}
      />
    </>
  );
}

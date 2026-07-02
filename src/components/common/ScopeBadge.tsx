/**
 * ScopeBadge — read-only Company › Branch chip with an optional
 * "Change scope" button.
 *
 * Surfaces what the page's figures reflect (active company, optional branch,
 * base currency) and delegates context switching to the existing
 * ContextSwitcherSheet — single source of truth, no parallel switcher UI.
 *
 * Visibility rules (aligned with Odoo / NetSuite / Dynamics):
 *  - Branch chip is hidden when the active company has only one branch.
 *  - The "Change scope" button is hidden when there is nothing meaningful
 *    to switch to AND the user cannot create a new workspace/company.
 *    The read-only chip remains so the user can always see their scope.
 */
import { useState } from "react";
import { Building2, MapPin, ChevronRight, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useCanSwitchScope } from "@/hooks/useCanSwitchScope";
import { useDeclareScope } from "@/contexts/AppLayoutContext";
import { useScopeSwitcherProps } from "@/hooks/useScopeSwitcherProps";
import { ContextSwitcherSheet } from "@/components/organization/ContextSwitcherSheet";

export interface ScopeBadgeProps {
  /**
   * When false, skip declaring the scope to the layout chip. Use when
   * another badge on the same page (e.g. DashboardScopeBadge) is the
   * authoritative declarer and ScopeBadge is only here for the trigger.
   */
  declareScope?: boolean;
}

export function ScopeBadge({ declareScope = true }: ScopeBadgeProps = {}) {
  const { currentBusiness } = useBusinesses();
  const { currentBranch, hasMultipleBranches } = useBranch();
  const { shouldShowTrigger } = useCanSwitchScope();
  const consolidatedProps = useScopeSwitcherProps();
  const [open, setOpen] = useState(false);

  const branchTail =
    hasMultipleBranches && currentBranch
      ? ` · ${currentBranch.name}${currentBranch.is_headquarters ? " (HQ)" : ""}`
      : "";
  useDeclareScope(
    declareScope && currentBusiness
      ? {
          kind: hasMultipleBranches ? "branch" : "business",
          label: `${currentBusiness.name}${branchTail}`,
          hint: currentBusiness.base_currency ?? undefined,
        }
      : null,
  );

  if (!currentBusiness) return null;


  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary" className="gap-1.5">
          <Building2 className="h-3 w-3" />
          {currentBusiness.name}
        </Badge>

        {hasMultipleBranches && currentBranch && (
          <>
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <Badge variant="secondary" className="gap-1.5">
              <MapPin className="h-3 w-3" />
              {currentBranch.name}
              {currentBranch.is_headquarters ? " · HQ" : ""}
            </Badge>
          </>
        )}

        {currentBusiness.base_currency && (
          <span className="text-muted-foreground">· {currentBusiness.base_currency}</span>
        )}

        {shouldShowTrigger && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(true)}
          >
            <Settings2 className="h-3 w-3 mr-1" />
            Change scope
          </Button>
        )}
      </div>

      {shouldShowTrigger && (
        <ContextSwitcherSheet
          open={open}
          onOpenChange={setOpen}
          {...consolidatedProps}
        />
      )}
    </>
  );
}

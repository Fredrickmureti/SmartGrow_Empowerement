/**
 * SidebarContextSwitcher
 *
 * Single Odoo-aligned trigger that opens the unified ContextSwitcherSheet.
 * Replaces the legacy <BusinessSwitcher /> + <BranchSwitcher /> stack which
 * exposed misleading "All Businesses" / "All Branches" pseudo-modes.
 *
 * Vocabulary: Workspace › Company › Branch (matches DB tables organizations,
 * businesses, branches; matches industry standards: Odoo, QuickBooks, Xero).
 */

import { useState } from "react";
import { Building2, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";
import { useCanSwitchScope } from "@/hooks/useCanSwitchScope";
import { ContextSwitcherSheet } from "./ContextSwitcherSheet";
import { CreateBusinessDialog } from "./CreateBusinessDialog";

interface SidebarContextSwitcherProps {
  collapsed?: boolean;
  onCreateOrg?: () => void;
}

export function SidebarContextSwitcher({ collapsed = false, onCreateOrg }: SidebarContextSwitcherProps) {
  const { currentOrg, isLoading: isOrgLoading } = useOrganization();
  const { currentBusiness, businesses, isLoading: isBusinessLoading } = useBusinesses();
  const { currentBranch, branches } = useBranch();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [showCreateBusiness, setShowCreateBusiness] = useState(false);
  const { shouldShowTrigger } = useCanSwitchScope();

  // Treat the whole org → business chain as "loading" until both layers
  // have settled. This prevents the cold-load flicker where the label
  // briefly reads "Set up your company" before the company name resolves
  // (BusinessContext.isLoading flips to false a tick before currentBusiness
  // is assigned, and OrganizationContext can hydrate after first paint).
  const isContextLoading =
    isOrgLoading ||
    isBusinessLoading ||
    (!!currentOrg && !currentBusiness && businesses.length > 0);

  // Primary label: company name, skeleton while loading, CTA only when
  // we're certain there is no company to show.
  const primaryLabel = currentBusiness?.name
    ?? (isContextLoading ? null : "Set up your company");

  // Secondary label: only show branch if multiple branches exist for this company
  const showBranch = !!currentBranch && branches.length >= 2;

  // Reusable skeleton bar so the sidebar height never jumps between the
  // loading and resolved states.
  const labelSkeleton = (
    <span className="inline-block h-3.5 w-24 rounded bg-muted animate-pulse" />
  );

  if (collapsed) {
    return (
      <>
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className={cn("h-9 w-9", !shouldShowTrigger && "cursor-default")}
              onClick={shouldShowTrigger ? () => setSheetOpen(true) : undefined}
              aria-disabled={!shouldShowTrigger}
            >
              <Building2 className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            {primaryLabel ?? "Loading…"}
            {showBranch && <span className="text-muted-foreground"> · {currentBranch.name}</span>}
          </TooltipContent>
        </Tooltip>
        {shouldShowTrigger && (
          <ContextSwitcherSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            onCreateOrg={onCreateOrg}
            onCreateBusiness={() => setShowCreateBusiness(true)}
          />
        )}
        <CreateBusinessDialog open={showCreateBusiness} onOpenChange={setShowCreateBusiness} />
      </>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        className={cn(
          "w-full justify-between gap-2 h-auto py-2",
          !currentBusiness && "text-muted-foreground",
          !shouldShowTrigger && "cursor-default hover:bg-background",
        )}
        onClick={shouldShowTrigger ? () => setSheetOpen(true) : undefined}
        aria-disabled={!shouldShowTrigger}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Building2 className="h-4 w-4 shrink-0" />
          <div className="flex flex-col items-start min-w-0 flex-1">
            <span className="text-sm font-medium truncate w-full text-left">
              {primaryLabel ?? labelSkeleton}
            </span>
            {showBranch && (
              <span className="text-[10px] text-muted-foreground truncate w-full text-left">
                {currentBranch.name}{currentBranch.is_headquarters ? " · HQ" : ""}
              </span>
            )}
          </div>
        </div>
        {shouldShowTrigger && (
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        )}
      </Button>
      {shouldShowTrigger && (
        <ContextSwitcherSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          onCreateOrg={onCreateOrg}
          onCreateBusiness={() => setShowCreateBusiness(true)}
        />
      )}
      <CreateBusinessDialog open={showCreateBusiness} onOpenChange={setShowCreateBusiness} />
    </>
  );
}

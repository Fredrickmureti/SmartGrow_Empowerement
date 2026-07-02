/**
 * ScopeOwnershipBadge — POS Stage R4.
 *
 * Renders a small chip that tells the operator which branch a register,
 * shift, cashier, or session belongs to RELATIVE to the currently-active
 * branch context. Three states:
 *
 *   - "This branch"             owner === active
 *   - "Company-wide"            owner is NULL (shared/legacy row)
 *   - "Branch: X (read-only)"   owner !== active (overseer view only)
 *
 * Pure presentation. Does NOT enforce permissions — server-side RLS +
 * RPC asserts (`assert_pos_caller_branch_access`) are the authority.
 * This badge exists so HQ overseers cannot mis-rescue / mis-edit a
 * foreign-branch entity by accident.
 */
import { Badge } from "@/components/ui/badge";
import { Building2, Globe, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ScopeOwnershipBadgeProps {
  ownerBranchId: string | null | undefined;
  ownerBranchName?: string | null;
  activeBranchId: string | null | undefined;
  className?: string;
}

export function ScopeOwnershipBadge({
  ownerBranchId,
  ownerBranchName,
  activeBranchId,
  className,
}: ScopeOwnershipBadgeProps) {
  if (ownerBranchId == null) {
    return (
      <Badge variant="secondary" className={cn("gap-1 text-xs font-normal", className)}>
        <Globe className="h-3 w-3" />
        Company-wide
      </Badge>
    );
  }
  if (activeBranchId && ownerBranchId === activeBranchId) {
    return (
      <Badge variant="outline" className={cn("gap-1 text-xs font-normal border-primary/40 text-primary", className)}>
        <Building2 className="h-3 w-3" />
        This branch
      </Badge>
    );
  }
  return (
    <Badge variant="destructive" className={cn("gap-1 text-xs font-normal", className)}>
      <Lock className="h-3 w-3" />
      {ownerBranchName ? `Branch: ${ownerBranchName} (read-only)` : "Other branch (read-only)"}
    </Badge>
  );
}

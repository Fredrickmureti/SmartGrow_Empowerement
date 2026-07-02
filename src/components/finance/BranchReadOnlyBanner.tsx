/**
 * BranchReadOnlyBanner — shown on business-level finance pages
 * (Chart of Accounts, Fiscal Periods, Finance Settings, Tax Mappings)
 * when the active user is operating inside a specific branch and lacks
 * the corresponding business-management permission.
 *
 * Communicates: "this is managed at the parent business; switch to
 * 'All branches' or contact your finance admin to make changes here."
 */
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Lock } from "lucide-react";
import { useFinanceScope } from "@/hooks/finance/useFinanceScope";

interface BranchReadOnlyBannerProps {
  /** Short label of the area, e.g. "Chart of Accounts", "Fiscal Periods". */
  area: string;
  /** Optional — name of the permission that would unlock editing. */
  permissionLabel?: string;
}

export function BranchReadOnlyBanner({ area, permissionLabel }: BranchReadOnlyBannerProps) {
  const { isBranchScopedReadOnly } = useFinanceScope();
  // Only render when the user is in a NON-HQ branch context inside a
  // multi-branch business. HQ branch IS the parent-business edit surface
  // for shared finance config, so HQ users see the normal editable UI.
  if (!isBranchScopedReadOnly) return null;
  return (
    <Alert className="border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30">
      <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-900 dark:text-amber-200">{area} is read-only in this branch</AlertTitle>
      <AlertDescription className="text-amber-800 dark:text-amber-300/90">
        {area} is managed at the parent business and shared across all branches.
        Switch to the headquarters branch from the branch switcher, or ask a user
        with the {permissionLabel ?? "finance management"} permission to make changes.
      </AlertDescription>
    </Alert>
  );
}

/**
 * FinanceReadOnlyNotice — the single, humane way to tell a user that a
 * finance surface is view-only for their role.
 *
 * Rules (Odoo / Xero / QuickBooks parity):
 *   - Never render while the permission answer is still loading. Callers
 *     pass `isLoading` and this component returns null in that state, so a
 *     page load never flashes a denial wall.
 *   - Informational tone and styling, not `destructive`. Being a viewer is
 *     a normal state, not an error.
 *   - The raw permission code is support metadata: it lives in the `title`
 *     tooltip, never in the visible copy.
 */
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Lock } from "lucide-react";

interface FinanceReadOnlyNoticeProps {
  /** What the user can still do, e.g. "review default account mappings". */
  what: string;
  /** Permission code, surfaced only as a tooltip for support. */
  permission?: string;
  /** True while the permission answer is unresolved — renders nothing. */
  isLoading?: boolean;
  /** Whether the read-only state applies at all. */
  readOnly: boolean;
}

export function FinanceReadOnlyNotice({
  what,
  permission,
  isLoading,
  readOnly,
}: FinanceReadOnlyNoticeProps) {
  if (isLoading || !readOnly) return null;
  return (
    <Alert
      className="border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30"
      title={permission ? `Requires ${permission}` : undefined}
    >
      <Lock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertDescription className="text-xs text-amber-900 dark:text-amber-200">
        View only — you can {what}. Editing is limited to owners, admins and
        accountants; ask one of them to make changes.
      </AlertDescription>
    </Alert>
  );
}

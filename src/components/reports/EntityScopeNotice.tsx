/**
 * Says which company a drill-down opened, when a link chose it.
 *
 * A consolidated figure is a group number; the ledger beneath it is one
 * company's. When the viewer arrives from such a link the active company is
 * switched to match (see `useEntityScopeFromUrl`), and that switch must be
 * visible — an unannounced context change is how a user ends up reading
 * Company B's ledger believing it is Company A's.
 *
 * If the link named a company the viewer cannot reach, the notice says so
 * instead of leaving an unexplained empty report. It withholds nothing the
 * server would have withheld: access is still decided by RLS.
 */

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Building2, Lock } from "lucide-react";
import { useEntityScopeFromUrl } from "@/hooks/reports/useEntityScopeFromUrl";

export function EntityScopeNotice() {
  const { requestedBusinessId, requestedBusinessName, denied } = useEntityScopeFromUrl();

  if (!requestedBusinessId) return null;

  if (denied) {
    return (
      <Alert variant="destructive" className="mb-4">
        <Lock className="h-4 w-4" />
        <AlertDescription className="text-sm">
          This link points at a company you are not permitted to open. Nothing from that
          company is shown here.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert className="mb-4">
      <Building2 className="h-4 w-4" />
      <AlertDescription className="text-sm">
        Showing <span className="font-medium">{requestedBusinessName}</span> — the company
        that owns the records behind the consolidated figure you drilled into.
      </AlertDescription>
    </Alert>
  );
}

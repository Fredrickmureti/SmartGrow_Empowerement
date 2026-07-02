/**
 * ActiveBranchBadge
 *
 * Always-visible chip showing which branch the user is operating in.
 *
 * F7 (audit): always render once a branch is selected, even for
 * single-branch companies. A user who belongs to multiple companies of
 * mixed shapes (some single-branch, some multi-branch) needs the chip
 * to remain visible so context never silently disappears across switches.
 */
import { useBranches } from "@/hooks/useBranches";
import { Badge } from "@/components/ui/badge";
import { MapPin } from "lucide-react";

export function ActiveBranchBadge() {
  const { currentBranch, isLoading } = useBranches();

  // Show a neutral loading state while branches are being fetched. This
  // prevents a brief flash of the destructive "No branch selected"
  // message during initial hydration.
  if (isLoading) {
    return (
      <Badge variant="outline" className="gap-1.5 opacity-70">
        <MapPin className="h-3 w-3" />
        Loading branch…
      </Badge>
    );
  }

  if (!currentBranch) {
    return (
      <Badge variant="destructive" className="gap-1.5">
        <MapPin className="h-3 w-3" />
        No branch selected
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="gap-1.5">
      <MapPin className="h-3 w-3" />
      {currentBranch.name}
      {currentBranch.is_headquarters ? " · HQ" : ""}
    </Badge>
  );
}

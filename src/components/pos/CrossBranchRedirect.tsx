/**
 * CrossBranchRedirect — Stage B branch isolation gate for the POS terminal.
 *
 * Shown when the operator attempts to open a register that belongs to a
 * branch other than the currently-active one (or when no branch is
 * selected at all). Offers a one-click switch into the register's branch
 * when the user has access to it; otherwise instructs them to switch via
 * the branch picker.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangle, MapPin, LogOut } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useBranch } from "@/contexts/BranchContext";
import { useMemo } from "react";

interface Props {
  registerBranchId: string;
  registerBranchName: string | null;
  activeBranchId: string | null;
}

export function CrossBranchRedirect({
  registerBranchId,
  registerBranchName,
  activeBranchId,
}: Props) {
  const navigate = useNavigate();
  const { branches, switchBranch, currentBranch } = useBranch();
  const targetBranch = useMemo(
    () => branches.find((b) => b.id === registerBranchId) ?? null,
    [branches, registerBranchId],
  );
  const canSwitch = !!targetBranch;

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <Card className="max-w-lg w-full border-destructive/40">
        <CardHeader>
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <CardTitle className="text-lg">Cross-branch terminal blocked</CardTitle>
          </div>
          <CardDescription>
            This POS register belongs to a different branch than the one you
            are currently operating in. Opening it from the wrong branch
            context would post sales, stock movements, and cash events to
            the wrong operational scope.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-2">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Register branch:</span>
              <span className="font-medium">
                {registerBranchName ?? "Unknown branch"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Active branch:</span>
              <span className="font-medium">
                {currentBranch?.name ?? (activeBranchId ? activeBranchId : "None (HQ / oversight)")}
              </span>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            {canSwitch ? (
              <Button
                className="flex-1"
                onClick={() => switchBranch(registerBranchId)}
              >
                Switch to {targetBranch?.name}
              </Button>
            ) : (
              <Button className="flex-1" variant="secondary" disabled>
                You do not have access to this branch
              </Button>
            )}
            <Button
              variant="outline"
              className="sm:w-auto"
              onClick={() => navigate("/pos")}
            >
              <LogOut className="h-4 w-4 mr-2" />
              Back to POS
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

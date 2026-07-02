/**
 * BranchScopeGate — Phase F operational guard for inventory pages.
 *
 * Twin of `CompanyScopeGate`, applied at the inventory route level.
 *
 * Inventory operations (receiving, picking, adjustments, transfers, reorder
 * points) are *branch* operations: stock physically lives at one location.
 * If a workspace's active company has ≥2 branches and none is selected,
 * we block the page rather than silently aggregating across all branches —
 * which would let an operator dispatch from a warehouse they don't realise
 * isn't theirs.
 *
 * Single-branch companies render normally — there is nothing to disambiguate.
 */
import { ReactNode } from "react";
import { useBranches } from "@/hooks/useBranches";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Building2, MapPin } from "lucide-react";

interface BranchScopeGateProps {
  children: ReactNode;
  /** Optional human label, e.g. "Stock levels". */
  pageName?: string;
}

export function BranchScopeGate({
  children,
  pageName = "this page",
}: BranchScopeGateProps) {
  const { branches, currentBranch, isLoading } = useBranches();

  if (isLoading) return <>{children}</>;
  if (branches.length <= 1) return <>{children}</>;
  if (currentBranch) return <>{children}</>;

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Building2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>Select a branch first</CardTitle>
              <CardDescription>
                Your company has {branches.length} branches. {pageName} reflects
                stock and movements at one branch at a time — pick a branch in
                the header switcher to continue.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p className="flex items-center gap-2">
            <MapPin className="h-4 w-4" />
            Stock truth is per warehouse, and warehouses live in branches —
            mixing them would misreport availability.
          </p>
          <p>
            Need an across-branch view? Use the inventory reports — they offer
            an explicit "All branches in this company" toggle.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

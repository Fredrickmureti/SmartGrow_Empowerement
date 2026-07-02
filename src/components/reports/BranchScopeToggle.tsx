/**
 * BranchScopeToggle
 *
 * Two-mode filter for inventory reports:
 *   - "branch": only show stock & movements for the active branch (default
 *     when a branch is selected)
 *   - "company": show all branches in the active company (HQ-style consolidated
 *     view, the Odoo "parent vs branch" report distinction)
 *
 * Hidden when the active company has only one branch — the choice would be
 * meaningless and visually noisy.
 */
import { useBranches } from "@/hooks/useBranches";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Building2, Network } from "lucide-react";

export type BranchScope = "branch" | "company";

interface Props {
  value: BranchScope;
  onChange: (v: BranchScope) => void;
}

export function BranchScopeToggle({ value, onChange }: Props) {
  const { branches, currentBranch } = useBranches();
  if (!branches || branches.length < 2) return null;

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">Scope</p>
      <Tabs value={value} onValueChange={(v) => onChange(v as BranchScope)}>
        <TabsList className="h-8">
          <TabsTrigger value="branch" className="text-xs gap-1.5" disabled={!currentBranch}>
            <Building2 className="h-3 w-3" />
            {currentBranch?.name || "Current branch"}
          </TabsTrigger>
          <TabsTrigger value="company" className="text-xs gap-1.5">
            <Network className="h-3 w-3" />
            All branches
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}

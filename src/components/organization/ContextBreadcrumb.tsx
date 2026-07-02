import { Building, Building2, MapPin, ChevronRight } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface ContextBreadcrumbProps {
  showBranch?: boolean;
  className?: string;
}

export function ContextBreadcrumb({ showBranch = true, className }: ContextBreadcrumbProps) {
  const { currentOrg, isLoading: orgLoading } = useOrganization();
  const { currentBusiness, isLoading: businessLoading } = useBusinesses();
  const { currentBranch, isLoading: branchLoading } = useBranch();

  if (orgLoading || businessLoading) {
    return <Skeleton className="h-5 w-48" />;
  }

  if (!currentOrg) {
    return null;
  }

  return (
    <div className={`flex items-center gap-1.5 text-xs text-muted-foreground ${className}`}>
      {/* Organization */}
      <div className="flex items-center gap-1">
        <Building className="h-3 w-3" />
        <span className="font-medium truncate max-w-[100px]" title={currentOrg.name}>
          {currentOrg.name}
        </span>
      </div>

      {/* Company (only when one exists — never show 'All Companies') */}
      {currentBusiness && (
        <>
          <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
          <div className="flex items-center gap-1">
            <Building2 className="h-3 w-3" />
            <span className="truncate max-w-[100px]" title={currentBusiness.name}>
              {currentBusiness.name}
            </span>
          </div>
        </>
      )}

      {/* Branch */}
      {showBranch && currentBranch && !branchLoading && (
        <>
          <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
          <div className="flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            <span className="truncate max-w-[80px]" title={currentBranch.name}>
              {currentBranch.name}
            </span>
            {currentBranch.is_headquarters && (
              <Badge variant="secondary" className="text-[9px] px-1 py-0 h-3.5">
                HQ
              </Badge>
            )}
          </div>
        </>
      )}
    </div>
  );
}

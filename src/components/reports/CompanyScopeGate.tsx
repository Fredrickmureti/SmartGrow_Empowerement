/**
 * CompanyScopeGate — Phase G consolidation guard.
 *
 * Reports must read books from EXACTLY ONE legal entity. If the active
 * workspace has ≥2 companies and none is selected, render an explanatory
 * block instead of the report and link to /reports/consolidation.
 *
 * This is the same gate `useGeneralLedger` enforces server-side, applied
 * uniformly to every financial / inventory / tax / payroll report so that
 * cross-company aggregation is never displayed by accident.
 */

import { ReactNode } from "react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { GitMerge, Building2 } from "lucide-react";
import { useNavigate } from "react-router-dom";

interface CompanyScopeGateProps {
  children: ReactNode;
  /** Optional human label, e.g. "Trial Balance". Used in the empty-state copy. */
  reportName?: string;
}

export function CompanyScopeGate({ children, reportName = "this report" }: CompanyScopeGateProps) {
  const { currentBusiness, businesses, isLoading } = useBusinesses();
  const navigate = useNavigate();

  if (isLoading) return <>{children}</>;

  // Single-company workspace: nothing to gate, render normally.
  if (businesses.length <= 1) return <>{children}</>;

  // Multi-company workspace WITH a selected company: render normally.
  if (currentBusiness) return <>{children}</>;

  // Multi-company, none selected → block.
  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Building2 className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle>Select a company first</CardTitle>
              <CardDescription>
                Your workspace has {businesses.length} companies. {reportName} reflects the books of one
                legal entity at a time — pick a company in the sidebar switcher to continue.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Looking for figures across all your companies? That requires intercompany
            eliminations and currency translation, which live in a dedicated consolidation
            module.
          </p>
          <Button variant="outline" size="sm" onClick={() => navigate("/finance/reports/cross-company")}>
            <GitMerge className="h-4 w-4 mr-2" />
            Open Consolidation
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

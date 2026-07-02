/**
 * HR Ops — Onboarding Issues
 *
 * Surfaces failed `onboarding_attempts` rows so HR can remediate orphan or
 * broken invitation accepts (Wave audit item — visibility instead of silent
 * success). Backed by the `hr_list_failed_onboarding_attempts` RPC, which
 * enforces that the caller is an org admin.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface FailedAttempt {
  id: string;
  user_id: string;
  status: string;
  company_name: string | null;
  error_message: string | null;
  diagnostics: Record<string, any> | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

export default function OnboardingIssues() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;

  const { data, isLoading, error } = useQuery({
    queryKey: ["hr-failed-onboarding-attempts", orgId],
    enabled: !!orgId,
    staleTime: 30_000,
    queryFn: async (): Promise<FailedAttempt[]> => {
      const { data, error } = await (supabase as any).rpc(
        "hr_list_failed_onboarding_attempts",
        { p_org_id: orgId, p_limit: 200 },
      );
      if (error) throw error;
      return (data ?? []) as FailedAttempt[];
    },
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Onboarding Issues</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Failed or blocked invitation acceptances that need HR follow-up.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}

      {error && (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            Could not load onboarding issues: {(error as Error).message}
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && (data ?? []).length === 0 && (
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <div>
              <div className="font-medium">No failed onboarding attempts</div>
              <div className="text-sm text-muted-foreground">
                Every recent invitation completed cleanly.
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {(data ?? []).map((row) => (
        <Card key={row.id}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              {row.company_name || "Invitation"}
              <Badge variant={row.status === "blocked" ? "destructive" : "secondary"}>
                {row.status}
              </Badge>
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {formatDistanceToNow(new Date(row.updated_at), { addSuffix: true })}
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {row.error_message && (
              <div>
                <span className="font-medium">Reason:</span>{" "}
                <span className="text-muted-foreground">{row.error_message}</span>
              </div>
            )}
            {row.diagnostics?.remediation && (
              <div>
                <span className="font-medium">Remediation:</span>{" "}
                <span className="text-muted-foreground">
                  {String(row.diagnostics.remediation)}
                </span>
              </div>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Diagnostics
              </summary>
              <pre className="mt-2 text-xs bg-muted p-2 rounded overflow-auto">
                {JSON.stringify(row.diagnostics ?? {}, null, 2)}
              </pre>
            </details>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

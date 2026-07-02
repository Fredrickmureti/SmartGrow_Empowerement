/**
 * BranchNullDiagnostic — admin-only read-only view that surfaces rows on
 * branch-scoped tables whose `branch_id IS NULL` for the active
 * organization. These rows are effectively company-wide under the
 * `applyBranchFilter` convention and silently bleed across branches on a
 * multi-branch tenant. This page exists so an admin can see the blast
 * radius; remediation is a separate per-tenant migration (out of scope).
 */
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { usePermissions } from "@/hooks/usePermissions";

interface CountRow {
  table_name: string;
  row_count: number;
}

export default function BranchNullDiagnostic() {
  const { currentOrg } = useOrganization();
  const permissions = usePermissions();
  const isAdmin = !!permissions.canManageOrganization;

  const { data, isLoading, error } = useQuery({
    queryKey: ["branch-null-diagnostic", currentOrg?.id],
    queryFn: async (): Promise<CountRow[]> => {
      if (!currentOrg?.id) return [];
      const { data, error } = await supabase.rpc(
        "branch_null_diagnostic_counts" as any,
        { _organization_id: currentOrg.id } as any,
      );
      if (error) throw error;
      return ((data ?? []) as Array<{ table_name: string; row_count: number | string }>).map((r) => ({
        table_name: r.table_name,
        row_count: Number(r.row_count),
      }));
    },
    enabled: !!currentOrg?.id && isAdmin,
    staleTime: 60_000,
  });

  if (!isAdmin) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Branch-NULL Diagnostic</CardTitle>
            <CardDescription>This diagnostic is restricted to organization administrators.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const total = (data ?? []).reduce((acc, r) => acc + r.row_count, 0);

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="page-title">Branch-NULL Diagnostic</h1>
        <p className="text-sm text-muted-foreground">
          Rows on branch-scoped tables with <code>branch_id IS NULL</code> for
          this organization. Under the platform's branch-filter convention,
          these are visible to every branch.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Failed to load diagnostic — RPC denied or unavailable.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Per-table counts
              <Badge variant={total > 0 ? "destructive" : "secondary"}>{total} total</Badge>
            </CardTitle>
            <CardDescription>Top 500 most recent rows per table available via RPC drill-down.</CardDescription>
          </CardHeader>
          <CardContent>
            {(data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No branch-NULL rows detected. Every branch-scoped row is bound to a branch.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2">Table</th>
                    <th className="py-2 text-right">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.map((r) => (
                    <tr key={r.table_name} className="border-t border-border">
                      <td className="py-2 font-mono">{r.table_name}</td>
                      <td className="py-2 text-right">{r.row_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
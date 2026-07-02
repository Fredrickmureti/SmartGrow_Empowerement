/**
 * FinanceIntegrity (Phase 6)
 *
 * Lists open `finance_integrity_issues` raised by the nightly integrity job,
 * grouped by `issue_code`. Admins can mark issues resolved (the RLS policy
 * `Admins can resolve integrity issues` enforces the same gate server-side,
 * so non-admins still get a 403 even if the button is shown).
 */
import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
// Org-level admin check derived from useOrganization (same pattern as
// src/pages/Expenses.tsx — no dedicated useUserRole hook in this repo).
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

interface IntegrityIssue {
  id: string;
  organization_id: string;
  business_id: string | null;
  issue_code: string;
  severity: "info" | "warning" | "error" | "critical";
  source_type: string;
  source_id: string | null;
  details: Record<string, any>;
  detected_at: string;
  resolved_at: string | null;
}

const severityVariant: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  info: "secondary",
  warning: "outline",
  error: "destructive",
  critical: "destructive",
};

const ISSUE_LABELS: Record<string, { title: string; description: string }> = {
  payroll_je_unbalanced: {
    title: "Payroll journal entries unbalanced",
    description: "Posted payroll runs whose generated journal entries have debits ≠ credits.",
  },
};

export default function FinanceIntegrity() {
  const { currentOrg, userRole } = useOrganization();
  const isAdmin =
    userRole?.role === "admin" || userRole?.role === "owner" || userRole?.role === "super_admin";
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: issues, isLoading } = useQuery({
    queryKey: ["finance_integrity_issues", currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [] as IntegrityIssue[];
      const { data, error } = await supabase
        .from("finance_integrity_issues")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .is("resolved_at", null)
        .order("detected_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as IntegrityIssue[];
    },
    enabled: !!currentOrg?.id,
  });

  const resolveMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("finance_integrity_issues")
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by: (await supabase.auth.getUser()).data.user?.id ?? null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Issue resolved" });
      queryClient.invalidateQueries({ queryKey: ["finance_integrity_issues"] });
    },
    onError: (err: any) => {
      toast({ title: "Could not resolve", description: err.message, variant: "destructive" });
    },
  });

  const grouped = useMemo(() => {
    const m = new Map<string, IntegrityIssue[]>();
    for (const issue of issues ?? []) {
      const arr = m.get(issue.issue_code) ?? [];
      arr.push(issue);
      m.set(issue.issue_code, arr);
    }
    return Array.from(m.entries());
  }, [issues]);

  if (isLoading) {
    return (
      <div className="container mx-auto py-8 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div className="flex items-center gap-3">
        <ShieldAlert className="h-7 w-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Finance integrity</h1>
          <p className="text-sm text-muted-foreground">
            Open issues detected by the nightly integrity job.
          </p>
        </div>
      </div>

      {grouped.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" />
            <p className="text-lg font-medium">All clear</p>
            <p className="text-sm text-muted-foreground">
              No open finance integrity issues for this organization.
            </p>
          </CardContent>
        </Card>
      ) : (
        grouped.map(([code, rows]) => {
          const meta = ISSUE_LABELS[code] ?? {
            title: code,
            description: "Detected integrity issue.",
          };
          return (
            <Card key={code}>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5 text-amber-500" />
                      {meta.title}
                    </CardTitle>
                    <CardDescription>{meta.description}</CardDescription>
                  </div>
                  <Badge variant="secondary">{rows.length} open</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {rows.map((issue) => (
                  <div
                    key={issue.id}
                    className="flex items-start justify-between gap-4 rounded-md border p-3"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant={severityVariant[issue.severity] ?? "secondary"}>
                          {issue.severity}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(issue.detected_at), { addSuffix: true })}
                        </span>
                      </div>
                      <div className="text-sm">
                        <span className="font-mono text-xs">
                          {issue.source_type}
                          {issue.source_id ? `: ${issue.source_id.slice(0, 8)}` : ""}
                        </span>
                      </div>
                      <pre className="text-xs bg-muted rounded p-2 overflow-x-auto max-w-full">
                        {JSON.stringify(issue.details, null, 2)}
                      </pre>
                    </div>
                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={resolveMutation.isPending}
                        onClick={() => resolveMutation.mutate(issue.id)}
                      >
                        Mark resolved
                      </Button>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}

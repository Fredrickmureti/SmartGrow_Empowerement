// @ts-nocheck - RPC types not regenerated yet
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { format } from "date-fns";
import { Loader2, RefreshCw, AlertTriangle, CheckCircle2, Clock, PlayCircle } from "lucide-react";

interface DeletionJob {
  id: string;
  organization_id: string;
  organization_name: string | null;
  kind: string;
  status: string;
  attempts: number;
  error_text: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

interface Props {
  organizationId?: string;
}

const STATUS_STYLES: Record<string, { color: string; icon: any; label: string }> = {
  pending: { color: "bg-blue-500/10 text-blue-600 border-blue-200", icon: Clock, label: "Pending" },
  running: { color: "bg-amber-500/10 text-amber-600 border-amber-200", icon: PlayCircle, label: "Running" },
  completed: { color: "bg-green-500/10 text-green-600 border-green-200", icon: CheckCircle2, label: "Completed" },
  failed: { color: "bg-red-500/10 text-red-600 border-red-200", icon: AlertTriangle, label: "Failed" },
  cancelled: { color: "bg-muted text-muted-foreground border-border", icon: Clock, label: "Cancelled" },
};

export function DeletionJobsPanel({ organizationId }: Props) {
  const [jobs, setJobs] = useState<DeletionJob[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await (supabase as any).rpc("get_organization_deletion_jobs", {
        _org_id: organizationId ?? null,
      });
      if (error) throw error;
      setJobs((data as DeletionJob[]) ?? []);
    } catch (e) {
      console.error("Failed to load deletion jobs", e);
      setJobs([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Poll every 30s for fresh status
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [organizationId]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            Deletion Jobs
          </CardTitle>
          <CardDescription className="text-xs">
            Scheduled and executed tenant hard-delete operations.
          </CardDescription>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </CardHeader>
      <CardContent>
        {loading && jobs.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading jobs…
          </div>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No deletion jobs on record.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {!organizationId && <TableHead>Organization</TableHead>}
                  <TableHead>Status</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Scheduled For</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((j) => {
                  const s = STATUS_STYLES[j.status] ?? STATUS_STYLES.pending;
                  const Icon = s.icon;
                  return (
                    <TableRow key={j.id}>
                      {!organizationId && (
                        <TableCell className="font-medium text-xs">
                          {j.organization_name ?? j.organization_id.slice(0, 8)}
                        </TableCell>
                      )}
                      <TableCell>
                        <Badge variant="outline" className={`${s.color} text-[11px] gap-1`}>
                          <Icon className="h-3 w-3" />
                          {s.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{j.kind}</TableCell>
                      <TableCell className="text-xs">
                        {j.scheduled_for ? format(new Date(j.scheduled_for), "MMM d, yyyy HH:mm") : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {j.started_at ? format(new Date(j.started_at), "MMM d, HH:mm") : "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {j.finished_at ? format(new Date(j.finished_at), "MMM d, HH:mm") : "—"}
                      </TableCell>
                      <TableCell className="text-right text-xs">{j.attempts}</TableCell>
                      <TableCell className="text-xs max-w-[240px] truncate text-destructive">
                        {j.error_text ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

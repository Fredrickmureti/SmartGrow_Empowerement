/**
 * Automation Execution Logs Viewer
 * 
 * Shows execution history with status, timing, and error details.
 * Includes circuit breaker status and reset capability.
 */

import { useAutomationLogs, AutomationLog } from "@/hooks/useAutomationLogs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  History,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  RefreshCw,
  Loader2,
  Zap,
} from "lucide-react";
import { format } from "date-fns";
import { ENTITY_TYPE_LABELS, EntityType } from "@/hooks/useEntityFields";
import { TRIGGER_TYPE_LABELS, TriggerType } from "@/hooks/useAutomations";

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; color: string; label: string }> = {
  completed: { icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: "text-green-600 dark:text-green-400", label: "Completed" },
  failed: { icon: <XCircle className="h-3.5 w-3.5" />, color: "text-destructive", label: "Failed" },
  partial: { icon: <AlertTriangle className="h-3.5 w-3.5" />, color: "text-amber-600 dark:text-amber-400", label: "Partial" },
  running: { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />, color: "text-blue-600", label: "Running" },
  pending: { icon: <Clock className="h-3.5 w-3.5" />, color: "text-muted-foreground", label: "Pending" },
  skipped: { icon: <Clock className="h-3.5 w-3.5" />, color: "text-muted-foreground", label: "Skipped" },
};

export function AutomationExecutionLogs() {
  const { logs, isLoading, refetch } = useAutomationLogs();

  const stats = {
    total: logs.length,
    completed: logs.filter(l => l.status === "completed").length,
    failed: logs.filter(l => l.status === "failed").length,
    partial: logs.filter(l => l.status === "partial").length,
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            Execution Logs
          </h2>
          <p className="text-xs text-muted-foreground">
            Recent automation execution history and results
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />
          Refresh
        </Button>
      </div>

      {/* Stats bar */}
      <div className="flex gap-4 text-sm">
        <div className="flex items-center gap-1.5">
          <Zap className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Total:</span>
          <span className="font-medium">{stats.total}</span>
        </div>
        <div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-4 w-4" />
          <span>{stats.completed}</span>
        </div>
        <div className="flex items-center gap-1.5 text-destructive">
          <XCircle className="h-4 w-4" />
          <span>{stats.failed}</span>
        </div>
        {stats.partial > 0 && (
          <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            <span>{stats.partial}</span>
          </div>
        )}
      </div>

      {logs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <History className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No execution logs yet</h3>
            <p className="text-muted-foreground text-sm">
              Logs will appear here when automations are triggered
            </p>
          </CardContent>
        </Card>
      ) : (
        <ScrollArea className="max-h-[600px]">
          <div className="space-y-2">
            {logs.map((log) => (
              <LogEntry key={log.id} log={log} />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function LogEntry({ log }: { log: AutomationLog }) {
  const statusConfig = STATUS_CONFIG[log.status] || STATUS_CONFIG.pending;
  const duration = log.started_at && log.completed_at
    ? Math.round((new Date(log.completed_at).getTime() - new Date(log.started_at).getTime()))
    : null;

  const stepsArray = Array.isArray(log.steps_executed) ? log.steps_executed : [];

  return (
    <Accordion type="single" collapsible>
      <AccordionItem value={log.id} className="border rounded-lg px-3">
        <AccordionTrigger className="py-2 hover:no-underline">
          <div className="flex items-center gap-3 w-full mr-2">
            <div className={statusConfig.color}>
              {statusConfig.icon}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <div className="flex items-center gap-2 text-sm">
                <Badge variant="outline" className="text-xs">
                  {TRIGGER_TYPE_LABELS[log.trigger_type as TriggerType] || log.trigger_type}
                </Badge>
                <span className="text-muted-foreground">→</span>
                <span className="text-xs font-medium">
                  {ENTITY_TYPE_LABELS[log.target_model as EntityType] || log.target_model}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
              {duration !== null && (
                <span>{duration}ms</span>
              )}
              <span>{format(new Date(log.created_at), "MMM d, HH:mm:ss")}</span>
            </div>
          </div>
        </AccordionTrigger>
        <AccordionContent className="pb-3">
          <div className="space-y-2 text-xs">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <span className="text-muted-foreground">Status:</span>{" "}
                <span className={`font-medium ${statusConfig.color}`}>{statusConfig.label}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Record:</span>{" "}
                <span className="font-mono">{log.target_record_id?.slice(0, 8) || "—"}</span>
              </div>
            </div>

            {log.error_message && (
              <div className="p-2 rounded bg-destructive/10 border border-destructive/20 text-destructive">
                <span className="font-medium">Error:</span> {log.error_message}
              </div>
            )}

            {stepsArray.length > 0 && (
              <>
                <Separator />
                <div className="space-y-1">
                  <span className="font-medium text-muted-foreground">Steps ({stepsArray.length}):</span>
                  {stepsArray.map((step: any, i: number) => {
                    const stepStatus = step.success ? "completed" : "failed";
                    const sc = STATUS_CONFIG[stepStatus];
                    return (
                      <div key={i} className="flex items-center gap-2 pl-2">
                        <span className={sc.color}>{sc.icon}</span>
                        <span>{step.action_type || `Step ${i + 1}`}</span>
                        {step.error && (
                          <span className="text-destructive truncate ml-auto max-w-[200px]">
                            {step.error}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

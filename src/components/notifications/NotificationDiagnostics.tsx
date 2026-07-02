import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { AlertTriangle, CheckCircle2, RefreshCcw, XCircle, Inbox, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { normalizeError } from "@/services/resilience";

interface RuleStatusRow {
  rule_id: string;
  event_type: string;
  is_enabled: boolean;
  recipient_type: string;
  has_template: boolean;
  recipient_count: number;
}

interface OutboxRow {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export function NotificationDiagnostics() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;
  const queryClient = useQueryClient();

  const { data: rules, isLoading: rulesLoading } = useQuery({
    queryKey: ["notification-diagnostics-rules", orgId],
    queryFn: async (): Promise<RuleStatusRow[]> => {
      if (!orgId) return [];
      const { data: ruleRows, error } = await supabase
        .from("sms_event_rules")
        .select("id, event_type, is_enabled, recipient_type, template_id")
        .eq("organization_id", orgId)
        .order("event_type");
      if (error) throw error;

      const ruleIds = (ruleRows || []).map((r) => r.id);
      if (ruleIds.length === 0) return [];

      const { data: recipientRows } = await supabase
        .from("sms_event_rule_recipients")
        .select("rule_id")
        .in("rule_id", ruleIds);

      const counts = new Map<string, number>();
      for (const r of recipientRows || []) {
        counts.set(r.rule_id, (counts.get(r.rule_id) || 0) + 1);
      }

      return (ruleRows || []).map((r) => ({
        rule_id: r.id,
        event_type: r.event_type,
        is_enabled: r.is_enabled,
        recipient_type: r.recipient_type,
        has_template: !!r.template_id,
        recipient_count: counts.get(r.id) || 0,
      }));
    },
    enabled: !!orgId,
  });

  const { data: recentFailures, isLoading: failuresLoading } = useQuery({
    queryKey: ["notification-diagnostics-failures", orgId],
    queryFn: async (): Promise<OutboxRow[]> => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("sms_event_outbox")
        .select("id, event_type, status, attempts, last_error, created_at")
        .eq("organization_id", orgId)
        .in("status", ["failed", "skipped", "processing"])
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data || []) as OutboxRow[];
    },
    enabled: !!orgId,
    refetchInterval: 15000,
  });

  const { data: emailFailures, isLoading: emailFailuresLoading } = useQuery({
    queryKey: ["notification-diagnostics-email-failures", orgId],
    queryFn: async (): Promise<OutboxRow[]> => {
      if (!orgId) return [];
      const { data, error } = await (supabase as any)
        .from("email_event_outbox")
        .select("id, event_type, status, attempts, last_error, created_at")
        .eq("organization_id", orgId)
        .in("status", ["failed", "skipped", "processing", "sent"])
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) {
        // Table may not yet exist on stale schemas; treat as empty.
        return [];
      }
      return (data || []) as OutboxRow[];
    },
    enabled: !!orgId,
    refetchInterval: 15000,
  });

  const retryMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("sms_event_outbox")
        .update({
          status: "queued",
          attempts: 0,
          last_error: null,
          next_attempt_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Re-queued for delivery");
      queryClient.invalidateQueries({ queryKey: ["notification-diagnostics-failures"] });
    },
    onError: (e: Error) => toast.error(normalizeError(e).message),
  });

  const isLoading = rulesLoading || failuresLoading || emailFailuresLoading;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const enabledRules = (rules || []).filter((r) => r.is_enabled);
  const misconfiguredRules = enabledRules.filter(
    (r) => r.recipient_type === "internal" && r.recipient_count === 0,
  );

  return (
    <div className="space-y-4">
      {misconfiguredRules.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Notifications won't be delivered</AlertTitle>
          <AlertDescription>
            {misconfiguredRules.length} enabled internal alert
            {misconfiguredRules.length === 1 ? " has" : "s have"} no recipients configured. Add at
            least one recipient (group, role, or phone) so the engine has someone to notify.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Rule status</CardTitle>
          <CardDescription>
            Each enabled event rule must have at least one recipient and a template, otherwise the
            dispatcher will skip it silently.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b">
                <tr className="text-left text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Event</th>
                  <th className="py-2 pr-4 font-medium">Enabled</th>
                  <th className="py-2 pr-4 font-medium">Audience</th>
                  <th className="py-2 pr-4 font-medium">Recipients</th>
                  <th className="py-2 pr-4 font-medium">Template</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {(rules || []).map((r) => {
                  const ok =
                    r.is_enabled &&
                    (r.recipient_type !== "internal" || r.recipient_count > 0);
                  return (
                    <tr key={r.rule_id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{r.event_type}</td>
                      <td className="py-2 pr-4">
                        {r.is_enabled ? (
                          <Badge variant="default">On</Badge>
                        ) : (
                          <Badge variant="secondary">Off</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-4 capitalize">{r.recipient_type}</td>
                      <td className="py-2 pr-4">
                        {r.recipient_type === "customer" ? (
                          <span className="text-muted-foreground">via linked contact</span>
                        ) : r.recipient_count > 0 ? (
                          <span>{r.recipient_count}</span>
                        ) : (
                          <Badge variant="destructive">None</Badge>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {r.has_template ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : (
                          <span className="text-xs text-muted-foreground">default</span>
                        )}
                      </td>
                      <td className="py-2">
                        {!r.is_enabled ? (
                          <span className="text-muted-foreground">—</span>
                        ) : ok ? (
                          <Badge variant="outline" className="gap-1">
                            <CheckCircle2 className="h-3 w-3 text-green-600" /> Ready
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="gap-1">
                            <XCircle className="h-3 w-3" /> Misconfigured
                          </Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {(rules || []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted-foreground">
                      No event rules configured for this organization yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Inbox className="h-4 w-4" />
            Recent delivery issues
          </CardTitle>
          <CardDescription>
            Outbox rows that failed, were skipped, or are stuck processing. Use Retry to put them
            back in the queue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(recentFailures || []).length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              No failures in the recent outbox.
            </div>
          ) : (
            <div className="space-y-2">
              {(recentFailures || []).map((row) => (
                <div
                  key={row.id}
                  className="flex items-start justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">{row.event_type}</span>
                      <Badge
                        variant={row.status === "failed" ? "destructive" : "secondary"}
                        className="capitalize"
                      >
                        {row.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })} ·{" "}
                        {row.attempts} attempt{row.attempts === 1 ? "" : "s"}
                      </span>
                    </div>
                    {row.last_error && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {row.last_error}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => retryMutation.mutate(row.id)}
                    disabled={retryMutation.isPending}
                  >
                    <RefreshCcw className="mr-1 h-3 w-3" />
                    Retry
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Inbox className="h-4 w-4" />
            Email channel
          </CardTitle>
          <CardDescription>
            Real-time email events for inventory and other alerts. Recipients default to org
            owners/admins/super-admins with email notifications enabled.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(emailFailures || []).length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              No email events in the recent outbox.
            </div>
          ) : (
            <div className="space-y-2">
              {(emailFailures || []).map((row) => (
                <div
                  key={row.id}
                  className="flex items-start justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs">{row.event_type}</span>
                      <Badge
                        variant={
                          row.status === "failed"
                            ? "destructive"
                            : row.status === "sent"
                              ? "default"
                              : "secondary"
                        }
                        className="capitalize"
                      >
                        {row.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })} ·{" "}
                        {row.attempts} attempt{row.attempts === 1 ? "" : "s"}
                      </span>
                    </div>
                    {row.last_error && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {row.last_error}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * AppAccessApprovalsInbox — tenant-admin queue of pending app-access requests.
 *
 * Reads `approval_requests` rows where `entity_type='app_access'` and
 * `status='pending'` for the active organization. Decisions go through the canonical
 * approval engine (`decideApproval` → `approval_decide`), which enforces
 * approver eligibility, quorum and the append-only hash-chained history.
 * The permission-group grant is executed by the engine-side executor
 * trigger on terminal approval.
 *
 * No new edge function — direct RPC keeps us under the 100-function budget.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
  CheckCircle2,
  XCircle,
  Inbox,
  Loader2,
  AppWindow,
  MessageSquare,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { decideApproval } from "@/lib/governance/approvalEngine";
import { useOrganization } from "@/hooks/useOrganization";
import { getAppById } from "@/lib/apps/registry";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

interface AccessRequestRow {
  id: string;
  organization_id: string;
  entity_reference: string | null; // app_id
  notes: string | null;
  requested_by: string | null;
  requested_at: string;
  status: string;
  requester?: { full_name: string | null; email: string | null } | null;
}

export function AppAccessApprovalsInbox() {
  const { currentOrg } = useOrganization();
  const qc = useQueryClient();
  const [denyTarget, setDenyTarget] = useState<AccessRequestRow | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const { data: requests = [], isLoading } = useQuery({
    enabled: !!currentOrg?.id,
    queryKey: ["app-access-approvals", currentOrg?.id],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("approval_requests")
        .select(
          "id, organization_id, entity_reference, notes, requested_by, requested_at, status",
        )
        .eq("organization_id", currentOrg!.id)
        .eq("entity_type", "app_access")
        .eq("status", "pending")
        .order("requested_at", { ascending: false });
      if (error) throw error;

      const rows = (data ?? []) as AccessRequestRow[];
      const userIds = Array.from(
        new Set(rows.map((r) => r.requested_by).filter(Boolean) as string[]),
      );
      if (userIds.length === 0) return rows;

      const { data: profiles } = await (supabase as any)
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", userIds);

      const byId = new Map(
        (profiles ?? []).map((p: any) => [p.user_id, p]),
      );
      return rows.map((r) => ({
        ...r,
        requester: r.requested_by ? (byId.get(r.requested_by) ?? null) : null,
      }));
    },
  });

  const approve = useMutation({
    mutationFn: async (id: string) => {
      await decideApproval(id, "approve");
    },
    onSuccess: () => {
      toast.success("Access granted");
      qc.invalidateQueries({ queryKey: ["app-access-approvals"] });
    },
    onError: (e: unknown) =>
      toast.error(
        `Could not approve: ${(e as Error)?.message ?? "unknown error"}`,
      ),
  });

  const deny = useMutation({
    mutationFn: async (args: { id: string; reason: string }) => {
      await decideApproval(args.id, "reject", args.reason || undefined);
    },
    onSuccess: () => {
      toast.success("Request denied");
      setDenyTarget(null);
      setDenyReason("");
      qc.invalidateQueries({ queryKey: ["app-access-approvals"] });
    },
    onError: (e: unknown) =>
      toast.error(
        `Could not deny: ${(e as Error)?.message ?? "unknown error"}`,
      ),
  });

  const count = requests.length;
  const headerLabel = useMemo(
    () => (count === 0 ? "No pending requests" : `${count} pending`),
    [count],
  );

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Inbox className="h-5 w-5 text-primary" />
                App access requests
              </CardTitle>
              <CardDescription>
                Team members who clicked an installed app they don't yet have
                permission for. Approving adds them to the matching system
                permission group.
              </CardDescription>
            </div>
            <Badge variant={count > 0 ? "default" : "secondary"}>
              {headerLabel}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : count === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              When team members request access to an app, requests appear here.
            </p>
          ) : (
            <div className="space-y-2">
              {requests.map((req) => {
                const app = req.entity_reference
                  ? getAppById(req.entity_reference)
                  : null;
                const requesterName =
                  req.requester?.full_name ||
                  req.requester?.email ||
                  "Unknown user";
                const Icon = app?.icon ?? AppWindow;
                return (
                  <div
                    key={req.id}
                    className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-lg border bg-card"
                  >
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <div
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                        style={{
                          backgroundColor: app
                            ? `${app.color}15`
                            : "hsl(var(--muted))",
                        }}
                      >
                        <Icon
                          className="h-5 w-5"
                          style={{
                            color: app?.color ?? "hsl(var(--muted-foreground))",
                          }}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium truncate">
                            {requesterName}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            wants{" "}
                            <span className="font-medium text-foreground">
                              {app?.name ?? req.entity_reference ?? "an app"}
                            </span>
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Requested{" "}
                          {formatDistanceToNow(new Date(req.requested_at), {
                            addSuffix: true,
                          })}
                        </div>
                        {req.notes && (
                          <div className="mt-2 text-sm text-muted-foreground flex gap-1.5 items-start">
                            <MessageSquare className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            <span className="italic">"{req.notes}"</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDenyTarget(req)}
                        disabled={approve.isPending || deny.isPending}
                      >
                        <XCircle className="h-4 w-4 mr-1" />
                        Deny
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => approve.mutate(req.id)}
                        disabled={approve.isPending || deny.isPending}
                      >
                        {approve.isPending ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 mr-1" />
                        )}
                        Approve
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={!!denyTarget}
        onOpenChange={(o) => {
          if (!o) {
            setDenyTarget(null);
            setDenyReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deny access request</DialogTitle>
            <DialogDescription>
              The requester will be notified. You can include a short reason —
              e.g. "Talk to your manager first" or "We're not using Payroll
              yet".
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="deny-reason">Reason (optional)</Label>
            <Textarea
              id="deny-reason"
              value={denyReason}
              onChange={(e) => setDenyReason(e.target.value)}
              placeholder="Optional context for the requester…"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDenyTarget(null)}
              disabled={deny.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                denyTarget &&
                deny.mutate({ id: denyTarget.id, reason: denyReason })
              }
              disabled={deny.isPending}
            >
              {deny.isPending && (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              )}
              Deny request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

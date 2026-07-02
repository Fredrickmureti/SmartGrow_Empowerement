/**
 * Blocked Attempts queue.
 *
 * Surfaces every self-action that was blocked by the SoD triggers
 * (`sod.self_action_blocked` events in `audit_logs`) for the active
 * organization. A co-signer can issue a one-time override against any
 * row with one click — the override dialog opens fully pre-filled
 * from the audit row, so there is zero typing of UUIDs or action keys.
 *
 * Mirrors how SAP GRC and Oracle Risk Cloud expose break-glass
 * approvals: the system records the refusal, an authorized co-signer
 * reviews the context, writes a reason, and signs.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Loader2,
  ShieldOff,
  ShieldCheck,
  AlertOctagon,
  Clock,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  SELF_ACTION_CATALOGUE,
  DB_KEY_TO_ENTITY_TYPE,
  ENTITY_TYPE_LABELS,
  type SelfActionEntityType,
} from "@/lib/governance/selfActionCatalogue";
import {
  SelfActionOverrideDialog,
  type OverridePrefill,
} from "@/components/governance/SelfActionOverrideDialog";

const LIMIT = 50;

interface BlockedRow {
  id: string;
  created_at: string;
  organization_id: string;
  user_id: string | null;        // actor
  action: string;                 // "sod.self_action_blocked"
  entity_type: string | null;     // db key — e.g. "bill"
  entity_id: string | null;
  new_values: {
    action_key?: string;
    subject?: string;
    mode?: string;
  } | null;
}

interface DerivedRow extends BlockedRow {
  actionEntry: ReturnType<typeof actionKeyEntry>;
  entityType: SelfActionEntityType | null;
  actorName: string;
  actorEmail: string | null;
}

function actionKeyEntry(actionKey: string | undefined) {
  if (!actionKey) return null;
  return SELF_ACTION_CATALOGUE.find((e) => e.key === actionKey) ?? null;
}

export function BlockedAttemptsQueue() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const [prefill, setPrefill] = useState<OverridePrefill | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: rows = [], isLoading, error } = useQuery({
    queryKey: ["sod-blocked-attempts", orgId],
    enabled: !!orgId,
    refetchInterval: 30_000,
    queryFn: async (): Promise<BlockedRow[]> => {
      const { data, error } = await supabase
        .from("audit_logs")
        .select("id, created_at, organization_id, user_id, action, entity_type, entity_id, new_values")
        .eq("organization_id", orgId!)
        .eq("action", "sod.self_action_blocked")
        .order("created_at", { ascending: false })
        .limit(LIMIT);
      if (error) throw error;
      return (data ?? []) as unknown as BlockedRow[];
    },
  });

  // Resolve actor display names (profiles join — RLS-safe).
  const actorIds = useMemo(
    () => Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean) as string[])),
    [rows],
  );
  const { data: actors = [] } = useQuery({
    queryKey: ["sod-blocked-actor-profiles", actorIds.sort().join(",")],
    enabled: actorIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .in("user_id", actorIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  const derived: DerivedRow[] = useMemo(() => {
    const profileMap = new Map(actors.map((a) => [a.user_id, a]));
    return rows.map((r) => {
      const actor = r.user_id ? profileMap.get(r.user_id) : null;
      const entityType: SelfActionEntityType | null =
        r.entity_type && DB_KEY_TO_ENTITY_TYPE[r.entity_type]
          ? DB_KEY_TO_ENTITY_TYPE[r.entity_type]
          : null;
      return {
        ...r,
        actionEntry: actionKeyEntry(r.new_values?.action_key),
        entityType,
        actorName: actor?.full_name?.trim() || actor?.email || "Unknown actor",
        actorEmail: actor?.email ?? null,
      };
    });
  }, [rows, actors]);

  const handleIssue = (row: DerivedRow) => {
    if (!row.entityType || !row.entity_id || !row.user_id || !row.new_values?.action_key) {
      return;
    }
    setPrefill({
      actionKey: row.new_values.action_key,
      actorUserId: row.user_id,
      subjectUserId: row.new_values.subject ?? null,
      entityType: row.entityType,
      entityId: row.entity_id,
      entityLabel: `${ENTITY_TYPE_LABELS[row.entityType]} ${row.entity_id.slice(0, 8)}`,
    });
    setDialogOpen(true);
  };

  if (!orgId) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldOff className="h-5 w-5" />
          Blocked attempts
        </CardTitle>
        <CardDescription>
          The last {LIMIT} self-approvals the database refused. Issue a one-time
          co-signed override on a row to unblock it — every field is captured from
          the refusal, you only write the reason.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive py-4">
            {(error as Error).message}
          </div>
        )}

        {!isLoading && !error && derived.length === 0 && (
          <div className="flex flex-col items-center text-center py-10 gap-2">
            <ShieldCheck className="h-10 w-10 text-emerald-500" />
            <p className="font-medium">No self-action blocks recorded.</p>
            <p className="text-sm text-muted-foreground">
              Every approval in this organization has passed segregation-of-duties
              checks.
            </p>
          </div>
        )}

        {!isLoading && !error && derived.length > 0 && (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[150px]">When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead className="w-[160px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                <TooltipProvider>
                  {derived.map((row) => {
                    const canOverride =
                      !!row.entityType && !!row.entity_id && !!row.user_id &&
                      !!row.new_values?.action_key;
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="text-xs text-muted-foreground">
                          <div className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {formatDistanceToNow(new Date(row.created_at), { addSuffix: true })}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{row.actorName}</div>
                          {row.actorEmail && (
                            <div className="text-xs text-muted-foreground truncate">
                              {row.actorEmail}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.actionEntry ? (
                            <>
                              <div className="text-sm">{row.actionEntry.label}</div>
                              <div className="text-xs text-muted-foreground font-mono">
                                {row.actionEntry.key}
                              </div>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground font-mono">
                              {row.new_values?.action_key ?? "unknown"}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          {row.entityType ? (
                            <Badge variant="outline">
                              {ENTITY_TYPE_LABELS[row.entityType]}
                            </Badge>
                          ) : (
                            <Badge variant="outline">{row.entity_type ?? "—"}</Badge>
                          )}
                          {row.entity_id && (
                            <div className="text-xs text-muted-foreground font-mono mt-1">
                              {row.entity_id.slice(0, 8)}…
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {canOverride ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => handleIssue(row)}
                            >
                              <ShieldCheck className="mr-2 h-3.5 w-3.5" />
                              Issue override
                            </Button>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button size="sm" variant="ghost" disabled>
                                  <AlertOctagon className="mr-2 h-3.5 w-3.5" />
                                  Incomplete
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>
                                Missing entity, actor, or action key — cannot pre-fill.
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TooltipProvider>
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      <SelfActionOverrideDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setPrefill(null);
        }}
        organizationId={orgId}
        prefill={prefill}
      />
    </Card>
  );
}

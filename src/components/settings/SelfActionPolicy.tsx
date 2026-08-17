import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useOrganization } from "@/hooks/useOrganization";
import { supabase } from "@/integrations/supabase/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, ShieldCheck, ShieldAlert, ChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  SELF_ACTION_CATALOGUE,
  SELF_ACTION_MODES,
  type SelfActionMode,
} from "@/lib/governance/selfActionCatalogue";
import { SelfActionOverrideDialog } from "@/components/governance/SelfActionOverrideDialog";
import { useGovernanceActionRegistry } from "@/hooks/governance/useGovernanceActionRegistry";

/** A row in the per-action table, sourced from the DB registry (authoritative). */
interface DisplayEntry {
  key: string;
  module: string;
  label: string;
  description: string;
}

const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

interface PolicyRow {
  id: string;
  organization_id: string;
  action_key: string;
  mode: SelfActionMode;
  applies_to_role: string | null;
  notes: string | null;
  updated_at: string;
}

const MODE_BADGE: Record<SelfActionMode, "default" | "destructive" | "secondary" | "outline"> = {
  block: "destructive",
  require_cosign: "secondary",
  warn: "outline",
  allow: "default",
};

export function SelfActionPolicy() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [overrideOpen, setOverrideOpen] = useState(false);
  const { data: registry = [] } = useGovernanceActionRegistry();

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["self-action-policy", orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("self_action_policy" as never)
        .select("*")
        .eq("organization_id", orgId)
        .order("action_key", { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as PolicyRow[];
    },
  });

  const byAction = useMemo(() => {
    const map = new Map<string, PolicyRow>();
    for (const r of rows) {
      // Only default-row (applies_to_role IS NULL) is shown in this table.
      if (r.applies_to_role === null) map.set(r.action_key, r);
    }
    return map;
  }, [rows]);

  const upsertPolicy = useMutation({
    mutationFn: async (args: { actionKey: string; mode: SelfActionMode }) => {
      if (!orgId) throw new Error("No organization selected");
      const existing = byAction.get(args.actionKey);
      if (existing) {
        const { error } = await supabase
          .from("self_action_policy" as never)
          .update({ mode: args.mode } as never)
          .eq("id", existing.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("self_action_policy" as never).insert({
          organization_id: orgId,
          action_key: args.actionKey,
          mode: args.mode,
          applies_to_role: null,
        } as never);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["self-action-policy", orgId] });
      toast({ title: "Policy updated" });
    },
    onError: (e: unknown) => {
      toast({
        title: "Could not update policy",
        description: e instanceof Error ? e.message : String(e),
        variant: "destructive",
      });
    },
  });

  // The governance registry in the database is the source of truth for which
  // actions exist. The static catalogue is only a compile-time mirror, so the
  // table must never be built from it alone — a module registered server-side
  // (e.g. Warehouse) would otherwise be invisible here and impossible to
  // configure. Parity between the two is enforced by
  // src/test/architecture/governance-action-registry-parity.test.ts.
  const grouped = useMemo(() => {
    const entries = new Map<string, DisplayEntry>();
    for (const e of SELF_ACTION_CATALOGUE) {
      entries.set(e.key, { key: e.key, module: e.module, label: e.label, description: e.description });
    }
    for (const r of registry) {
      entries.set(r.action_key, {
        key: r.action_key,
        module: titleCase(r.module),
        label: r.label,
        description: r.description,
      });
    }
    const map = new Map<string, DisplayEntry[]>();
    for (const entry of entries.values()) {
      const list = map.get(entry.module) ?? [];
      list.push(entry);
      map.set(entry.module, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.label.localeCompare(b.label));
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [registry]);


  if (!orgId) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              Advanced — per-action overrides
            </CardTitle>
            <CardDescription>
              For most teams the Governance mode above is enough. Use this table only when you
              want to override the default for a specific action. Any row you save here always
              wins over the mode default. Owners can also issue a one-time co-signed override
              for a genuine exception.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setOverrideOpen(true)}>
            <ShieldAlert className="mr-2 h-4 w-4" />
            Create override
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2">
              <ChevronDown className="h-4 w-4" />
              Show per-action table
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-6 pt-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          grouped.map(([module, entries]) => (
            <div key={module} className="space-y-2">
              <h4 className="text-sm font-semibold text-muted-foreground">{module}</h4>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Action</TableHead>
                      <TableHead className="hidden md:table-cell">Description</TableHead>
                      <TableHead className="w-[180px]">Mode</TableHead>
                      <TableHead className="w-[110px]">Current</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {entries.map((entry) => {
                      const current = byAction.get(entry.key);
                      const mode: SelfActionMode = current?.mode ?? "block";
                      const isCustom = !!current;
                      return (
                        <TableRow key={entry.key}>
                          <TableCell className="font-medium">
                            <div>{entry.label}</div>
                            <div className="text-xs text-muted-foreground font-mono">
                              {entry.key}
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                            {entry.description}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={mode}
                              onValueChange={(v) =>
                                upsertPolicy.mutate({
                                  actionKey: entry.key,
                                  mode: v as SelfActionMode,
                                })
                              }
                              disabled={upsertPolicy.isPending}
                            >
                              <SelectTrigger className="h-8">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {SELF_ACTION_MODES.map((m) => (
                                  <SelectItem key={m.value} value={m.value}>
                                    <div>
                                      <div className="font-medium">{m.label}</div>
                                      <div className="text-xs text-muted-foreground">
                                        {m.description}
                                      </div>
                                    </div>
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <Badge variant={isCustom ? MODE_BADGE[mode] : "outline"}>
                              {isCustom ? mode : "mode default"}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))
        )}
        <p className="text-xs text-muted-foreground">
          Changes apply at the database layer, so they are enforced whether the action is
          performed through the UI, a server function, or a direct API call.
        </p>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
      <SelfActionOverrideDialog
        open={overrideOpen}
        onOpenChange={setOverrideOpen}
        organizationId={orgId}
      />
    </Card>
  );
}

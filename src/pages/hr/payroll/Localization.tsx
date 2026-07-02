import { normalizeError } from "@/services/resilience";
/**
 * Tenant Localization Editor
 *
 * Mounts the shared `<PackEditorShell mode="tenant" />` and adds an
 * Upgrade-Proposals inbox above it. RLS scopes everything to the tenant's
 * installed packs; admin-only mutations are hidden by the shell when
 * mode="tenant".
 */
import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Inbox, Check, X, Layers, ChevronDown, ChevronUp } from "lucide-react";
import { toast } from "sonner";
import { useRequestFullWidth } from "@/contexts/AppLayoutContext";
import {
  PackEditorShell,
  usePackUpgradeProposals,
  useDecidePackUpgradeProposal,
  PackDiffView,
} from "@/features/localization";

export default function TenantLocalization() {
  useRequestFullWidth(true);
  const [proposalsCollapsed, setProposalsCollapsed] = useState(false);
  const { data: proposals, isLoading } = usePackUpgradeProposals({ status: "pending" });
  const decide = useDecidePackUpgradeProposal();

  const grouped = useMemo(() => {
    const map = new Map<string, typeof proposals>();
    (proposals ?? []).forEach((p) => {
      const k = p.pack_id;
      const arr = map.get(k) ?? [];
      arr.push(p);
      map.set(k, arr as any);
    });
    return Array.from(map.entries());
  }, [proposals]);

  const handle = async (id: string, decision: "accepted" | "rejected") => {
    try {
      await decide.mutateAsync({ proposal_id: id, decision });
      toast.success(decision === "accepted" ? "Upgrade accepted" : "Upgrade rejected");
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Decision failed");
    }
  };

  const acceptAll = async (ids: string[]) => {
    try {
      for (const id of ids) await decide.mutateAsync({ proposal_id: id, decision: "accepted" });
      toast.success(`Accepted ${ids.length} upgrade${ids.length === 1 ? "" : "s"}`);
    } catch (e: any) {
      toast.error(normalizeError(e).message ?? "Bulk accept failed");
    }
  };

  const pendingCount = proposals?.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Layers className="h-5 w-5 text-muted-foreground" />
            Localization customization
          </h1>
          <p className="text-sm text-muted-foreground">
            Customize installed country packs and review pending upgrades from the platform team.
          </p>
        </div>
        {pendingCount > 0 && (
          <Badge variant="secondary" className="self-start sm:self-auto">
            <Inbox className="h-3.5 w-3.5 mr-1" />
            {pendingCount} pending upgrade{pendingCount === 1 ? "" : "s"}
          </Badge>
        )}
      </div>

      {(isLoading || grouped.length > 0) && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Inbox className="h-4 w-4" />
              Upgrade proposals
              {pendingCount > 0 && (
                <Badge variant="secondary" className="ml-1">{pendingCount}</Badge>
              )}
            </CardTitle>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setProposalsCollapsed((v) => !v)}
              aria-label={proposalsCollapsed ? "Expand proposals" : "Collapse proposals"}
            >
              {proposalsCollapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
            </Button>
          </CardHeader>
          {!proposalsCollapsed && (
            <CardContent className="space-y-3">
              {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
              {!isLoading && grouped.length === 0 && (
                <div className="text-sm text-muted-foreground">No pending upgrades.</div>
              )}
              <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
                {grouped.map(([packId, items]) => (
                  <Card key={packId} className="bg-muted/30">
                    <CardHeader className="pb-2 flex flex-row items-center justify-between">
                      <div className="text-xs">
                        Pack <code>{packId.slice(0, 8)}…</code>
                        <span className="text-muted-foreground ml-2">
                          {items!.length} change{items!.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => acceptAll(items!.map((x) => x.id))}
                        disabled={decide.isPending}
                      >
                        Accept all
                      </Button>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {items!.map((p) => (
                        <div key={p.id} className="rounded-md border bg-background p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="text-xs">
                              <span className="font-mono">v{p.from_version ?? "?"} → v{p.to_version}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => handle(p.id, "rejected")}
                                disabled={decide.isPending}
                              >
                                <X className="h-3.5 w-3.5 mr-1" />Reject
                              </Button>
                              <Button
                                size="sm"
                                onClick={() => handle(p.id, "accepted")}
                                disabled={decide.isPending}
                              >
                                {decide.isPending ? (
                                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5 mr-1" />
                                )}
                                Accept
                              </Button>
                            </div>
                          </div>
                          <PackDiffView
                            previous={p.diff?.before ?? {}}
                            next={p.diff?.after ?? {}}
                            title={`Diff v${p.from_version ?? "?"} → v${p.to_version}`}
                          />
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </div>
            </CardContent>
          )}
        </Card>
      )}

      <PackEditorShell mode="tenant" />
    </div>
  );
}

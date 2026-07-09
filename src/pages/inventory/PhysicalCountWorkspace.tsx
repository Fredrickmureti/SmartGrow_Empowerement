/**
 * Physical Count Workspace
 *
 * Enterprise Inventory Manager view over the persisted `physical_counts`
 * aggregate. Complements (rather than replaces) the counting wizard at
 * `/inventory-app/count`: this page shows every count that ever existed —
 * drafts, in-flight counts, in-review counts pending approval, approved
 * counts awaiting posting, posted counts with drill-down to the ledger,
 * and cancelled/superseded counts.
 *
 * All action buttons call the D2 lifecycle RPCs (physical_count_freeze,
 * _submit, _approve, _post, _cancel) — no client-side ledger writes.
 */

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { ClipboardCheck, ArrowRight, Loader2 } from "lucide-react";
import { normalizeError } from "@/services/resilience";
import { RecordHeader, ActionBar } from "@/design-system";
import { RefreshButton } from "@/components/ui/RefreshButton";

type CountState =
  | "draft" | "counting" | "counted" | "in_review"
  | "approved" | "posted" | "cancelled" | "superseded";

interface CountRow {
  id: string;
  count_number: string;
  warehouse_id: string;
  count_type: string;
  state: CountState;
  created_at: string;
  frozen_at: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  posted_at: string | null;
  posted_adjustment_ids: string[] | null;
  posted_journal_entry_id: string | null;
  created_by: string | null;
  submitted_by: string | null;
  approved_by: string | null;
  warehouses?: { name: string } | null;
}

const STATE_STYLES: Record<CountState, string> = {
  draft: "bg-muted text-muted-foreground",
  counting: "bg-blue-100 text-blue-800",
  counted: "bg-indigo-100 text-indigo-800",
  in_review: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  posted: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  superseded: "bg-gray-100 text-gray-800",
};

export default function PhysicalCountWorkspace() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"active" | "in_review" | "posted" | "all">("active");
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: counts = [], isLoading } = useQuery<CountRow[]>({
    queryKey: ["physical-counts-workspace", currentOrg?.id, currentBusiness?.id],
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("physical_counts")
        .select(
          "id, count_number, warehouse_id, count_type, state, created_at, frozen_at, submitted_at, approved_at, posted_at, posted_adjustment_ids, posted_journal_entry_id, created_by, submitted_by, approved_by, warehouses:warehouse_id(name)"
        )
        .eq("organization_id", currentOrg!.id)
        .eq("business_id", currentBusiness!.id)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as CountRow[];
    },
  });

  const buckets = useMemo(() => {
    const b: Record<string, CountRow[]> = { active: [], in_review: [], posted: [], all: counts };
    counts.forEach((c) => {
      if (["draft", "counting", "counted", "approved"].includes(c.state)) b.active.push(c);
      else if (c.state === "in_review") b.in_review.push(c);
      else if (c.state === "posted") b.posted.push(c);
    });
    return b;
  }, [counts]);

  const runRpc = async (id: string, action: "freeze" | "submit" | "approve" | "post" | "cancel") => {
    if (!user?.id) return;
    setBusyId(id);
    try {
      const rpcName = {
        freeze: "physical_count_freeze",
        submit: "physical_count_submit",
        approve: "physical_count_approve",
        post: "physical_count_post",
        cancel: "physical_count_cancel",
      }[action] as
        | "physical_count_freeze" | "physical_count_submit"
        | "physical_count_approve" | "physical_count_post" | "physical_count_cancel";

      const args: Record<string, unknown> = { p_count_id: id, p_user_id: user.id };
      if (action === "cancel") args.p_reason = "Cancelled from workspace";

      const { data, error } = await (supabase.rpc as unknown as (
        name: string, args: Record<string, unknown>
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(rpcName, args);
      if (error) throw error;
      const res = data as { success?: boolean; error?: string } | null;
      if (res && res.success === false) throw new Error(res.error || `${action} failed`);
      toast.success(`${action} succeeded`);
      qc.invalidateQueries({ queryKey: ["physical-counts-workspace"] });
    } catch (err: unknown) {
      const e = err as { message?: string; code?: string; hint?: string; details?: string } | null;
      const code = (e?.code || "").toString();
      const rawMsg = (e?.message || "").trim();
      // Postgres errors (P*, 23xxx integrity, 42xxx permission/syntax) always
      // carry actionable business context — surface it verbatim rather than
      // collapsing to a generic "input not valid" toast.
      const isPostgresError =
        rawMsg.length > 0 && /^(P|23|42)/.test(code);
      if (isPostgresError) {
        const description = e?.hint || e?.details || undefined;
        toast.error(rawMsg, description ? { description } : undefined);
      } else {
        toast.error(normalizeError(err).message);
      }
    } finally {
      setBusyId(null);
    }
  };

  const renderStateBadge = (s: CountState) => (
    <Badge className={STATE_STYLES[s]}>{s.replace("_", " ")}</Badge>
  );

  const renderTable = (rows: CountRow[]) => {
    if (isLoading) {
      return <div className="p-8 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>;
    }
    if (rows.length === 0) {
      return (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No counts in this bucket.
        </div>
      );
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Count</TableHead>
            <TableHead>Warehouse</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Created</TableHead>
            <TableHead>Posted</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => {
            const busy = busyId === c.id;
            return (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-xs">
                  <Link to={`/inventory-app/physical-counts/${c.id}`} className="hover:underline">
                    {c.count_number}
                  </Link>
                </TableCell>
                <TableCell>{c.warehouses?.name ?? "—"}</TableCell>
                <TableCell className="capitalize">{c.count_type}</TableCell>
                <TableCell>{renderStateBadge(c.state)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(c.created_at).toLocaleString()}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {c.posted_at ? new Date(c.posted_at).toLocaleString() : "—"}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    {c.state === "draft" && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => runRpc(c.id, "freeze")}>Freeze</Button>
                    )}
                    {c.state === "counting" && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => runRpc(c.id, "submit")}>Submit</Button>
                    )}
                    {c.state === "in_review" && (
                      <Button size="sm" variant="outline" disabled={busy} asChild>
                        <Link to={`/inventory-app/physical-counts/${c.id}`}>Review &amp; approve</Link>
                      </Button>
                    )}
                    {c.state === "approved" && (
                      <Button size="sm" disabled={busy} onClick={() => runRpc(c.id, "post")}>Post</Button>
                    )}
                    {["draft", "counting", "in_review", "approved"].includes(c.state) && (
                      <Button size="sm" variant="destructive" disabled={busy} onClick={() => runRpc(c.id, "cancel")}>Cancel</Button>
                    )}
                    {c.posted_journal_entry_id && (
                      <Button size="sm" variant="ghost" asChild>
                        <Link to={`/finance/journal-entries/${c.posted_journal_entry_id}`}>
                          JE <ArrowRight className="ml-1 h-3 w-3" />
                        </Link>
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <RecordHeader
        eyebrow="Inventory"
        title="Physical Count Workspace"
        meta={<span className="text-xs text-muted-foreground">Lifecycle view across draft, counting, review, approved, posted and cancelled counts.</span>}
        actions={
          <ActionBar>
            <RefreshButton
              queryKeyPrefixes={[["physical-counts-workspace"] as const]}
              tooltip="Refresh"
            />
            <Button asChild>
              <Link to="/inventory-app/count">
                <ClipboardCheck className="mr-2 h-4 w-4" /> New count
              </Link>
            </Button>
          </ActionBar>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Active</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{buckets.active.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">In review</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-amber-600">{buckets.in_review.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Posted</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold text-emerald-600">{buckets.posted.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">Total</CardTitle></CardHeader>
          <CardContent><div className="text-2xl font-bold">{counts.length}</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Counts</CardTitle>
          <CardDescription>
            Actions are gated by the count's state and by separation-of-duties: a user cannot
            approve a count they created, froze, or submitted.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
            <div className="px-4 pt-2">
              <TabsList>
                <TabsTrigger value="active">Active ({buckets.active.length})</TabsTrigger>
                <TabsTrigger value="in_review">In review ({buckets.in_review.length})</TabsTrigger>
                <TabsTrigger value="posted">Posted ({buckets.posted.length})</TabsTrigger>
                <TabsTrigger value="all">All ({counts.length})</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="active" className="mt-0">{renderTable(buckets.active)}</TabsContent>
            <TabsContent value="in_review" className="mt-0">{renderTable(buckets.in_review)}</TabsContent>
            <TabsContent value="posted" className="mt-0">{renderTable(buckets.posted)}</TabsContent>
            <TabsContent value="all" className="mt-0">{renderTable(counts)}</TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

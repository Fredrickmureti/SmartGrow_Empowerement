import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Clock, RefreshCw, Zap, XCircle } from "lucide-react";
import { Navigate } from "react-router-dom";

type TransmissionState =
  | "queued" | "transmitting" | "succeeded" | "rejected"
  | "retry_scheduled" | "failed" | "dead_letter" | "superseded";

interface Transmission {
  id: string;
  provider_key: string;
  document_kind: string;
  source_doc_type: string;
  source_doc_id: string;
  state: TransmissionState;
  attempt_count: number;
  next_attempt_at: string | null;
  fiscal_number: string | null;
  signature: string | null;
  qr_data: string | null;
  last_error: string | null;
  transmitted_at: string | null;
  created_at: string;
  response_payload: unknown;
  request_payload: unknown;
}

interface CircuitRow {
  provider_key: string;
  state: "closed" | "open" | "half_open";
  consecutive_failures: number;
  opened_at: string | null;
  next_probe_at: string | null;
  last_error: string | null;
}

const STATE_BADGE: Record<TransmissionState, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  queued: { label: "Queued", variant: "secondary" },
  transmitting: { label: "Transmitting", variant: "default" },
  succeeded: { label: "Succeeded", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
  retry_scheduled: { label: "Retry scheduled", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
  dead_letter: { label: "Dead letter", variant: "destructive" },
  superseded: { label: "Superseded", variant: "outline" },
};

export default function FiscalComplianceWorkspace() {
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id;

  // Kenya gate: check for an installed fiscal provider pack. If none, redirect.
  const { data: gate, isLoading: gateLoading } = useQuery({
    queryKey: ["fiscal-workspace-gate", orgId],
    queryFn: async () => {
      if (!orgId) return { enabled: false, provider: null as null | { provider_key: string; provider_name: string } };
      const sel = (s: string): string => s;
      const { data } = await supabase
        .from("localization_pack_fiscal_providers")
        .select(
          sel(
            "provider_key, provider_name, installed:installed_localization_packs!inner(organization_id)",
          ),
        )
        .eq("installed.organization_id", orgId)
        .limit(1)
        .returns<{ provider_key: string; provider_name: string }[]>();
      const row = (data ?? [])[0] as { provider_key: string; provider_name: string } | undefined;
      return { enabled: !!row, provider: row ?? null };
    },
    enabled: !!orgId,
  });

  const { data: transmissions, refetch: refetchTx } = useQuery({
    queryKey: ["fiscal-transmissions", orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from("fiscal_transmissions")
        .select("*")
        .eq("organization_id", orgId!)
        .order("created_at", { ascending: false })
        .limit(200);
      return (data ?? []) as unknown as Transmission[];
    },
    enabled: !!orgId && gate?.enabled === true,
    refetchInterval: 15000,
  });

  const { data: circuits } = useQuery({
    queryKey: ["fiscal-circuits", orgId],
    queryFn: async () => {
      const { data } = await supabase
        .from("fiscal_provider_circuit")
        .select("*")
        .eq("organization_id", orgId!);
      return (data ?? []) as unknown as CircuitRow[];
    },
    enabled: !!orgId && gate?.enabled === true,
    refetchInterval: 15000,
  });

  const [selected, setSelected] = useState<Transmission | null>(null);

  useEffect(() => {
    if (!orgId || !gate?.enabled) return;
    const channel = supabase
      .channel(`fiscal-transmissions-${orgId}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "fiscal_transmissions", filter: `organization_id=eq.${orgId}` },
        () => refetchTx())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [orgId, gate?.enabled, refetchTx]);

  if (gateLoading) return <div className="p-6 text-muted-foreground">Loading fiscal workspace…</div>;
  if (!gate?.enabled) return <Navigate to="/dashboard" replace />;

  const total = transmissions?.length ?? 0;
  const succeeded = transmissions?.filter(t => t.state === "succeeded").length ?? 0;
  const failing = transmissions?.filter(t => ["rejected", "failed", "dead_letter"].includes(t.state)).length ?? 0;
  const queued = transmissions?.filter(t => ["queued", "transmitting", "retry_scheduled"].includes(t.state)).length ?? 0;
  const lastSuccess = transmissions?.find(t => t.state === "succeeded")?.transmitted_at ?? null;

  const primaryCircuit = circuits?.[0];

  const resend = async (id: string) => {
    const { error } = await supabase.rpc("fiscal_transmission_resend" as never, { p_transmission_id: id } as never);
    if (error) toast.error(error.message);
    else { toast.success("Re-queued"); refetchTx(); }
  };

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Fiscal Compliance Workspace</h1>
        <p className="text-sm text-muted-foreground">
          {gate.provider?.provider_name ?? "Fiscal provider"} — event-driven transmission ledger, retries and audit.
        </p>
      </header>

      {/* Health strip */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-5">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Total (200)</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{total}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1"><CheckCircle2 className="h-4 w-4 text-green-600" />Succeeded</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{succeeded}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1"><Clock className="h-4 w-4" />Queued</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{queued}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1"><XCircle className="h-4 w-4 text-red-600" />Failing</CardTitle></CardHeader>
          <CardContent className="text-2xl font-semibold">{failing}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm flex items-center gap-1"><Zap className="h-4 w-4" />Circuit</CardTitle></CardHeader>
          <CardContent>
            <Badge variant={primaryCircuit?.state === "open" ? "destructive" : primaryCircuit?.state === "half_open" ? "outline" : "default"}>
              {primaryCircuit?.state ?? "closed"}
            </Badge>
            {primaryCircuit?.consecutive_failures ? (
              <div className="text-xs text-muted-foreground mt-1">
                {primaryCircuit.consecutive_failures} consecutive failures
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {lastSuccess && (
        <div className="text-sm text-muted-foreground">
          Last successful transmission: {new Date(lastSuccess).toLocaleString()}
        </div>
      )}

      {primaryCircuit?.state === "open" && (
        <Card className="border-destructive">
          <CardContent className="p-4 flex items-start gap-2">
            <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
            <div className="text-sm">
              <div className="font-medium">Provider circuit is open — transmissions are paused.</div>
              <div className="text-muted-foreground">
                Next probe: {primaryCircuit.next_probe_at ? new Date(primaryCircuit.next_probe_at).toLocaleString() : "—"}. POS
                continues to accept sales; queue drains automatically when the provider recovers.
              </div>
              {primaryCircuit.last_error && (
                <div className="mt-1 text-xs">Last error: {primaryCircuit.last_error}</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Queue */}
      <Card>
        <CardHeader><CardTitle>Transmission ledger</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Created</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Fiscal #</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(transmissions ?? []).map(t => (
                <TableRow key={t.id} onClick={() => setSelected(t)} className="cursor-pointer">
                  <TableCell className="text-xs">{new Date(t.created_at).toLocaleString()}</TableCell>
                  <TableCell>{t.document_kind}</TableCell>
                  <TableCell className="text-xs">{t.source_doc_type}</TableCell>
                  <TableCell><Badge variant={STATE_BADGE[t.state].variant}>{STATE_BADGE[t.state].label}</Badge></TableCell>
                  <TableCell>{t.attempt_count}</TableCell>
                  <TableCell className="text-xs">{t.fiscal_number ?? "—"}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {["rejected", "failed", "dead_letter", "retry_scheduled"].includes(t.state) && (
                      <Button size="sm" variant="outline" onClick={() => resend(t.id)}>
                        <RefreshCw className="h-3 w-3 mr-1" />Resend
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(transmissions ?? []).length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No transmissions yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Drill-down */}
      {selected && (
        <Card>
          <CardHeader>
            <CardTitle className="flex justify-between items-center">
              <span>Transmission drill-down</span>
              <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>Close</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div><span className="text-muted-foreground">Idempotency:</span> <code className="text-xs">{selected.source_doc_type}:{selected.source_doc_id}</code></div>
            <div><span className="text-muted-foreground">State:</span> {selected.state} (attempt {selected.attempt_count})</div>
            {selected.last_error && <div className="text-destructive">Last error: {selected.last_error}</div>}
            {selected.qr_data && <div><span className="text-muted-foreground">QR:</span> <code className="text-xs">{selected.qr_data}</code></div>}
            <details><summary className="cursor-pointer text-muted-foreground">Request payload</summary>
              <pre className="text-xs bg-muted p-2 mt-2 rounded overflow-auto max-h-72">{JSON.stringify(selected.request_payload, null, 2)}</pre>
            </details>
            <details><summary className="cursor-pointer text-muted-foreground">Response payload</summary>
              <pre className="text-xs bg-muted p-2 mt-2 rounded overflow-auto max-h-72">{JSON.stringify(selected.response_payload, null, 2)}</pre>
            </details>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

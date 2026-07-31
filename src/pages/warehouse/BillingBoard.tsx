/**
 * 3PL Billing Board — Phase 11.
 *
 * Activity-based billing for multi-tenant warehouses:
 *  - `wms_billing_tariffs` — master data (rate per activity per UoM per
 *    client), business-scoped, PostgREST writes gated by inventory:write.
 *  - `wms_billable_activities` — RPC-only ledger populated from
 *    `business_event_outbox` via `capture_billable_activity` /
 *    `capture_pending_billable_activities`.
 *  - `generate_3pl_invoice` — aggregates unbilled activity into a draft
 *    Sales invoice for a client and stamps the invoice link back onto
 *    the captured activity rows.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  PageHeader,
  PageBody,
  Section,
  LoadingState,
  EmptyState,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, RefreshCw, FileText, CalendarClock } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";

const ACTIVITIES = [
  "receive_lpn",
  "putaway",
  "pick_line",
  "pack_package",
  "dispatch_shipment",
  "yard_dwell",
  "qc_inspection",
  "cycle_count",
  "storage_lpn_day",
] as const;
type Activity = (typeof ACTIVITIES)[number];

interface Tariff {
  id: string;
  client_business_id: string | null;
  activity: string;
  uom: string;
  rate: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  notes: string | null;
}

interface Summary {
  client_business_id: string | null;
  activity: string;
  uom: string;
  currency: string | null;
  entry_count: number;
  total_quantity: number;
  total_amount: number;
  unbilled_amount: number;
  last_occurred_at: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonthIso(): string {
  const d = new Date();
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}

export default function BillingBoard() {
  const qc = useQueryClient();
  const { currentBusiness, businesses } = useBusinesses();

  const [clientFilter, setClientFilter] = useState<string>("all");
  const [tariffOpen, setTariffOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [accrualDate, setAccrualDate] = useState<string>(
    () => new Date().toISOString().slice(0, 10),
  );

  const [tariffForm, setTariffForm] = useState({
    client_business_id: "",
    activity: "pick_line" as Activity,
    uom: "unit",
    rate: 0.5,
    currency: "USD",
    effective_from: todayIso(),
    notes: "",
  });

  const [invoiceForm, setInvoiceForm] = useState({
    client_business_id: "",
    period_from: firstOfMonthIso(),
    period_to: todayIso(),
  });

  // ---------- Tariffs ----------
  const { data: tariffs, isLoading: tariffsLoading } = useQuery({
    queryKey: ["wms-billing-tariffs", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_billing_tariffs")
        .select("id,client_business_id,activity,uom,rate,currency,effective_from,effective_to,is_active,notes")
        .eq("business_id", currentBusiness!.id)
        .order("activity");
      if (error) throw error;
      return (data ?? []) as Tariff[];
    },
  });

  const createTariff = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id) throw new Error("No active business");
      const { error } = await supabase.from("wms_billing_tariffs").insert({
        business_id: currentBusiness.id,
        client_business_id: tariffForm.client_business_id || null,
        activity: tariffForm.activity,
        uom: tariffForm.uom.trim() || "unit",
        rate: Number(tariffForm.rate),
        currency: tariffForm.currency.trim().toUpperCase() || "USD",
        effective_from: tariffForm.effective_from,
        notes: tariffForm.notes.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Tariff saved");
      setTariffOpen(false);
      qc.invalidateQueries({ queryKey: ["wms-billing-tariffs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleTariff = useMutation({
    mutationFn: async (row: Tariff) => {
      const { error } = await supabase
        .from("wms_billing_tariffs")
        .update({ is_active: !row.is_active })
        .eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-billing-tariffs"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteTariff = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("wms_billing_tariffs").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Tariff removed");
      qc.invalidateQueries({ queryKey: ["wms-billing-tariffs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ---------- Activity summary ----------
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ["wms-billable-summary", currentBusiness?.id, clientFilter],
    enabled: !!currentBusiness?.id,
    refetchInterval: 30_000,
    queryFn: async () => {
      let q = supabase
        .from("wms_billable_activities_summary_view")
        .select("client_business_id,activity,uom,currency,entry_count,total_quantity,total_amount,unbilled_amount,last_occurred_at")
        .eq("business_id", currentBusiness!.id)
        .order("last_occurred_at", { ascending: false });
      if (clientFilter !== "all") {
        if (clientFilter === "__none__") {
          q = q.is("client_business_id", null);
        } else {
          q = q.eq("client_business_id", clientFilter);
        }
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Summary[];
    },
  });

  const captureDrain = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id) throw new Error("No active business");
      const { data, error } = await supabase.rpc("capture_pending_billable_activities", {
        p_business_id: currentBusiness.id,
        p_limit: 500,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (n) => {
      toast.success(`Captured ${n} activity ${n === 1 ? "entry" : "entries"}`);
      qc.invalidateQueries({ queryKey: ["wms-billable-summary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /**
   * Phase 5.4 — storage is time-based, so it can never arrive on the event
   * outbox. `wms_accrue_storage_days` snapshots occupying license plates for
   * a given day and writes one `storage_lpn_day` line per warehouse. The RPC
   * is idempotent, so re-running for the same day is a no-op.
   */
  const accrueStorage = useMutation({
    mutationFn: async (asOf: string) => {
      if (!currentBusiness?.id) throw new Error("No active business");
      const { data, error } = await supabase.rpc("wms_accrue_storage_days", {
        p_business_id: currentBusiness.id,
        p_as_of: asOf,
      });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (n) => {
      toast.success(
        n === 0
          ? "Storage already accrued for that date"
          : `Accrued storage for ${n} warehouse${n === 1 ? "" : "s"}`,
      );
      qc.invalidateQueries({ queryKey: ["wms-billable-summary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const generateInvoice = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id) throw new Error("No active business");
      if (!invoiceForm.client_business_id) throw new Error("Pick a client");
      const { data, error } = await supabase.rpc("generate_3pl_invoice", {
        p_business_id: currentBusiness.id,
        p_client_business_id: invoiceForm.client_business_id,
        p_period_from: invoiceForm.period_from,
        p_period_to: invoiceForm.period_to,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (inv: unknown) => {
      const row = inv as { invoice_number?: string } | null;
      toast.success(`Invoice ${row?.invoice_number ?? ""} generated`);
      setInvoiceOpen(false);
      qc.invalidateQueries({ queryKey: ["wms-billable-summary"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const totals = useMemo(() => {
    return (summary ?? []).reduce(
      (acc, r) => {
        acc.entries += Number(r.entry_count) || 0;
        acc.billed += Number(r.total_amount) || 0;
        acc.unbilled += Number(r.unbilled_amount) || 0;
        return acc;
      },
      { entries: 0, billed: 0, unbilled: 0 }
    );
  }, [summary]);

  const clientOptions = useMemo(() => {
    return (businesses ?? []).filter((b) => b.id !== currentBusiness?.id);
  }, [businesses, currentBusiness?.id]);

  const clientLabel = (id: string | null): string => {
    if (!id) return "Default (no client)";
    return clientOptions.find((c) => c.id === id)?.name ?? `${id.slice(0, 8)}…`;
  };

  return (
    <>
      <PageHeader
        title="3PL activity billing"
        description="Turn warehouse events into billable 3PL activity. Tariffs, activity ledger, and month-end invoice generation."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => captureDrain.mutate()} disabled={captureDrain.isPending}>
              <RefreshCw className="h-4 w-4 mr-2" /> Capture events
            </Button>
            <Button variant="outline" onClick={() => setInvoiceOpen(true)}>
              <FileText className="h-4 w-4 mr-2" /> Generate invoice
            </Button>
            <Button onClick={() => setTariffOpen(true)}>
              <Plus className="h-4 w-4 mr-2" /> New tariff
            </Button>
          </div>
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="w-72">
            <Label>Client</Label>
            <Select value={clientFilter} onValueChange={setClientFilter}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All clients</SelectItem>
                <SelectItem value="__none__">Default (no client)</SelectItem>
                {clientOptions.map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <KpiCard label="Activity entries" value={String(totals.entries)} />
          <KpiCard label="Billed amount" value={totals.billed.toFixed(2)} />
          <KpiCard label="Unbilled amount" value={totals.unbilled.toFixed(2)} tone={totals.unbilled > 0 ? "warn" : undefined} />
        </div>

        <Section title="Activity ledger" description="Rolling summary from wms_billable_activities_summary_view.">
          {summaryLoading ? (
            <LoadingState />
          ) : (summary ?? []).length === 0 ? (
            <EmptyState
              title="No captured activity yet"
              description="Use 'Capture events' to drain warehouse events into the billing ledger. Tariffs must exist for pricing to attach."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead>UoM</TableHead>
                  <TableHead className="text-right">Entries</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Unbilled</TableHead>
                  <TableHead>Currency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(summary ?? []).map((r, i) => (
                  <TableRow key={`${r.client_business_id ?? "none"}-${r.activity}-${r.uom}-${i}`}>
                    <TableCell>{clientLabel(r.client_business_id)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.activity}</TableCell>
                    <TableCell>{r.uom}</TableCell>
                    <TableCell className="text-right">{r.entry_count}</TableCell>
                    <TableCell className="text-right">{Number(r.total_quantity).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(r.total_amount).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(r.unbilled_amount).toFixed(2)}</TableCell>
                    <TableCell>{r.currency ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>

        <Section title="Tariffs" description="Rate per activity per UoM. Client-specific tariffs override the default (no client) tariff.">
          {tariffsLoading ? (
            <LoadingState />
          ) : (tariffs ?? []).length === 0 ? (
            <EmptyState
              title="No tariffs yet"
              description="Add a tariff so captured activity gets priced."
              action={<Button onClick={() => setTariffOpen(true)}><Plus className="h-4 w-4 mr-2" />New tariff</Button>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead>UoM</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(tariffs ?? []).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{clientLabel(t.client_business_id)}</TableCell>
                    <TableCell className="font-mono text-xs">{t.activity}</TableCell>
                    <TableCell>{t.uom}</TableCell>
                    <TableCell className="text-right">{Number(t.rate).toFixed(4)}</TableCell>
                    <TableCell>{t.currency}</TableCell>
                    <TableCell>{t.effective_from}</TableCell>
                    <TableCell>
                      <Switch checked={t.is_active} onCheckedChange={() => toggleTariff.mutate(t)} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteTariff.mutate(t.id)}
                        aria-label="Delete tariff"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </PageBody>

      {/* Tariff dialog */}
      <Dialog open={tariffOpen} onOpenChange={setTariffOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New billing tariff</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-2">
            <div>
              <Label>Client (leave blank for default)</Label>
              <Select
                value={tariffForm.client_business_id || "__none__"}
                onValueChange={(v) => setTariffForm((f) => ({ ...f, client_business_id: v === "__none__" ? "" : v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Default (no client)</SelectItem>
                  {clientOptions.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Activity</Label>
                <Select
                  value={tariffForm.activity}
                  onValueChange={(v) => setTariffForm((f) => ({ ...f, activity: v as Activity }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ACTIVITIES.map((a) => (
                      <SelectItem key={a} value={a} className="font-mono text-xs">{a}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Unit of measure</Label>
                <Input
                  value={tariffForm.uom}
                  onChange={(e) => setTariffForm((f) => ({ ...f, uom: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Rate</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.0001}
                  value={tariffForm.rate}
                  onChange={(e) => setTariffForm((f) => ({ ...f, rate: Number(e.target.value) }))}
                />
              </div>
              <div>
                <Label>Currency</Label>
                <Input
                  value={tariffForm.currency}
                  onChange={(e) => setTariffForm((f) => ({ ...f, currency: e.target.value }))}
                />
              </div>
              <div>
                <Label>Effective from</Label>
                <Input
                  type="date"
                  value={tariffForm.effective_from}
                  onChange={(e) => setTariffForm((f) => ({ ...f, effective_from: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Input
                value={tariffForm.notes}
                onChange={(e) => setTariffForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTariffOpen(false)}>Cancel</Button>
            <Button
              onClick={() => createTariff.mutate()}
              disabled={createTariff.isPending || tariffForm.rate < 0}
            >
              Save tariff
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invoice dialog */}
      <Dialog open={invoiceOpen} onOpenChange={setInvoiceOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Generate 3PL invoice</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-2">
            <div>
              <Label>Client</Label>
              <Select
                value={invoiceForm.client_business_id}
                onValueChange={(v) => setInvoiceForm((f) => ({ ...f, client_business_id: v }))}
              >
                <SelectTrigger><SelectValue placeholder="Pick a client" /></SelectTrigger>
                <SelectContent>
                  {clientOptions.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Period from</Label>
                <Input
                  type="date"
                  value={invoiceForm.period_from}
                  onChange={(e) => setInvoiceForm((f) => ({ ...f, period_from: e.target.value }))}
                />
              </div>
              <div>
                <Label>Period to</Label>
                <Input
                  type="date"
                  value={invoiceForm.period_to}
                  onChange={(e) => setInvoiceForm((f) => ({ ...f, period_to: e.target.value }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInvoiceOpen(false)}>Cancel</Button>
            <Button
              onClick={() => generateInvoice.mutate()}
              disabled={generateInvoice.isPending || !invoiceForm.client_business_id}
            >
              Generate draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function KpiCard({
  label, value, tone,
}: { label: string; value: string; tone?: "good" | "warn" | "bad" }) {
  const toneCls =
    tone === "good" ? "text-emerald-600" :
    tone === "warn" ? "text-amber-600" :
    tone === "bad"  ? "text-rose-600" : "";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className={`text-3xl font-semibold mt-1 ${toneCls}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

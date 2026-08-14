/**
 * 3PL Billing Board.
 *
 * Phase 1-2 model:
 *  - `wms_billing_clients` — the spine. One row per warehouse client,
 *    carrying the AR contact that actually gets invoiced, a short code,
 *    and the billing currency. Tariffs, activity and invoices all key
 *    off this row rather than off a sibling business.
 *  - `wms_billing_tariffs` — rate per (client, activity, uom, date).
 *    A NULL client is the business-wide default rate.
 *  - `wms_billable_activities` — RPC-only ledger drained from
 *    `business_event_outbox` (`capture_pending_billable_activities`)
 *    plus the time-based `wms_accrue_storage_days` accrual.
 *  - `generate_3pl_invoice` — aggregates unbilled activity for one
 *    client into a draft Sales invoice addressed to that client's AR
 *    contact, numbered through the canonical `generate_invoice_number`.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { applyPartyScope } from "@/lib/contactAddresses";
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
import { Badge } from "@/components/ui/badge";
import {
  Plus, Trash2, RefreshCw, FileText, CalendarClock, Users, Flag, Undo2,
} from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrencies } from "@/hooks/useCurrencies";

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

interface BillingClient {
  id: string;
  code: string;
  name: string | null;
  contact_id: string;
  currency: string | null;
  is_active: boolean;
}

interface Tariff {
  id: string;
  client_id: string | null;
  activity: string;
  uom: string;
  rate: number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
  notes: string | null;
  min_charge: number | null;
  included_quantity: number | null;
  tier_from: number | null;
  tier_to: number | null;
}

interface Summary {
  client_id: string | null;
  activity: string;
  uom: string;
  currency: string | null;
  entry_count: number;
  total_quantity: number;
  total_amount: number;
  unbilled_amount: number;
  unpriced_count: number;
  disputed_count: number;
  last_occurred_at: string;
}

/** One ledger row, shown in the corrections drill-down. */
interface LedgerEntry {
  id: string;
  client_id: string | null;
  activity: string;
  uom: string;
  quantity: number;
  amount: number | null;
  currency: string | null;
  occurred_at: string;
  invoice_id: string | null;
  disputed_at: string | null;
  dispute_reason: string | null;
  dispute_resolved_at: string | null;
  reverses_activity_id: string | null;
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
  const { currentBusiness } = useBusinesses();
  const { currencies } = useCurrencies();

  const [clientFilter, setClientFilter] = useState<string>("all");
  const [tariffOpen, setTariffOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [clientOpen, setClientOpen] = useState(false);
  const [accrualDate, setAccrualDate] = useState<string>(() => todayIso());

  const [clientForm, setClientForm] = useState({
    contact_id: "",
    code: "",
    currency: "",
  });

  const [tariffForm, setTariffForm] = useState({
    client_id: "",
    activity: "pick_line" as Activity,
    uom: "unit",
    rate: 0.5,
    currency: "USD",
    effective_from: todayIso(),
    notes: "",
    min_charge: "",
    included_quantity: "",
    tier_from: "",
    tier_to: "",
  });

  const [invoiceForm, setInvoiceForm] = useState({
    client_id: "",
    period_from: firstOfMonthIso(),
    period_to: todayIso(),
  });

  // ---------- Billing clients ----------
  const { data: clients, isLoading: clientsLoading } = useQuery({
    queryKey: ["wms-billing-clients", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_billing_clients")
        .select("id,code,name,contact_id,currency,is_active")
        .eq("business_id", currentBusiness!.id)
        .order("code");
      if (error) throw error;
      return (data ?? []) as BillingClient[];
    },
  });

  const { data: contacts } = useQuery({
    queryKey: ["wms-billing-contact-options", currentBusiness?.id],
    enabled: !!currentBusiness?.id && clientOpen,
    queryFn: async () => {
      const { data, error } = await applyPartyScope(
        supabase.from("contacts").select("id,name"),
      )
        .eq("business_id", currentBusiness!.id)
        .order("name")
        .limit(500);
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const createClient = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id) throw new Error("No active business");
      if (!clientForm.contact_id) throw new Error("Pick the customer to invoice");
      if (!clientForm.code.trim()) throw new Error("A client code is required");
      const { error } = await supabase.from("wms_billing_clients").insert({
        business_id: currentBusiness.id,
        organization_id: currentBusiness.organization_id ?? null,
        contact_id: clientForm.contact_id,
        code: clientForm.code.trim().toUpperCase(),
        name:
          contacts?.find((c) => c.id === clientForm.contact_id)?.name ?? null,
        currency: clientForm.currency || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Billing client added");
      setClientOpen(false);
      setClientForm({ contact_id: "", code: "", currency: "" });
      qc.invalidateQueries({ queryKey: ["wms-billing-clients"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleClient = useMutation({
    mutationFn: async (row: BillingClient) => {
      const { error } = await supabase
        .from("wms_billing_clients")
        .update({ is_active: !row.is_active })
        .eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wms-billing-clients"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  // ---------- Tariffs ----------
  const { data: tariffs, isLoading: tariffsLoading } = useQuery({
    queryKey: ["wms-billing-tariffs", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wms_billing_tariffs")
        .select(
          "id,client_id,activity,uom,rate,currency,effective_from,effective_to,is_active,notes,min_charge,included_quantity,tier_from,tier_to",
        )
        .eq("business_id", currentBusiness!.id)
        .order("activity");
      if (error) throw error;
      return (data ?? []) as Tariff[];
    },
  });

  const createTariff = useMutation({
    mutationFn: async () => {
      if (!currentBusiness?.id) throw new Error("No active business");
      const num = (v: string) => (v.trim() === "" ? null : Number(v));
      const from = num(tariffForm.tier_from);
      const to = num(tariffForm.tier_to);
      if (from !== null && to !== null && to <= from) {
        throw new Error("Tier ceiling must be above the tier floor");
      }
      const { error } = await supabase.from("wms_billing_tariffs").insert({
        business_id: currentBusiness.id,
        client_id: tariffForm.client_id || null,
        activity: tariffForm.activity,
        uom: tariffForm.uom.trim() || "unit",
        rate: Number(tariffForm.rate),
        currency: tariffForm.currency.trim().toUpperCase() || currentBusiness.base_currency,
        effective_from: tariffForm.effective_from,
        notes: tariffForm.notes.trim() || null,
        min_charge: num(tariffForm.min_charge),
        included_quantity: num(tariffForm.included_quantity),
        tier_from: from,
        tier_to: to,
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
        .select(
          "client_id,activity,uom,currency,entry_count,total_quantity,total_amount,unbilled_amount,unpriced_count,disputed_count,last_occurred_at",
        )
        .eq("business_id", currentBusiness!.id)
        .order("last_occurred_at", { ascending: false });
      if (clientFilter !== "all") {
        if (clientFilter === "__none__") {
          q = q.is("client_id", null);
        } else {
          q = q.eq("client_id", clientFilter);
        }
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Summary[];
    },
  });

  // ---------- Ledger entries (corrections drill-down) ----------
  const { data: entries, isLoading: entriesLoading } = useQuery({
    queryKey: ["wms-billable-entries", currentBusiness?.id, clientFilter],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("wms_billable_activities")
        .select(
          "id,client_id,activity,uom,quantity,amount,currency,occurred_at,invoice_id,disputed_at,dispute_reason,dispute_resolved_at,reverses_activity_id",
        )
        .eq("business_id", currentBusiness!.id)
        .order("occurred_at", { ascending: false })
        .limit(50);
      if (clientFilter !== "all") {
        if (clientFilter === "__none__") q = q.is("client_id", null);
        else q = q.eq("client_id", clientFilter);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as LedgerEntry[];
    },
  });

  const invalidateLedger = () => {
    qc.invalidateQueries({ queryKey: ["wms-billable-summary"] });
    qc.invalidateQueries({ queryKey: ["wms-billable-entries"] });
  };

  /**
   * Corrections never edit history: a dispute flags the row so the
   * invoice generator holds it back, and a reversal appends a mirrored
   * negative entry. Both are RPC-only (the ledger is immutable).
   */
  const disputeEntry = useMutation({
    mutationFn: async (row: LedgerEntry) => {
      const resolving = !!row.disputed_at && !row.dispute_resolved_at;
      const reason = window.prompt(
        resolving ? "Resolution note" : "Why is this entry disputed?",
        "",
      );
      if (reason === null || !reason.trim()) throw new Error("A reason is required");
      const { error } = await supabase.rpc("wms_dispute_billable_activity", {
        p_activity_id: row.id,
        p_reason: reason.trim(),
        p_resolve: resolving,
      });
      if (error) throw error;
      return resolving;
    },
    onSuccess: (resolving) => {
      toast.success(resolving ? "Dispute resolved" : "Entry disputed and held back");
      invalidateLedger();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const reverseEntry = useMutation({
    mutationFn: async (row: LedgerEntry) => {
      const reason = window.prompt("Why is this entry being reversed?", "");
      if (reason === null || !reason.trim()) throw new Error("A reason is required");
      const { error } = await supabase.rpc("wms_reverse_billable_activity", {
        p_activity_id: row.id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Reversing entry posted");
      invalidateLedger();
    },
    onError: (e: Error) => toast.error(e.message),
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
   * Storage is time-based, so it can never arrive on the event outbox.
   * `wms_accrue_storage_days` snapshots occupying license plates for a
   * given day and writes one `storage_lpn_day` line per warehouse. The
   * RPC is idempotent, so re-running for the same day is a no-op.
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
      if (!invoiceForm.client_id) throw new Error("Pick a client");
      const { data, error } = await supabase.rpc("generate_3pl_invoice", {
        p_business_id: currentBusiness.id,
        p_client_id: invoiceForm.client_id,
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
        acc.unpriced += Number(r.unpriced_count) || 0;
        acc.disputed += Number(r.disputed_count) || 0;
        return acc;
      },
      { entries: 0, billed: 0, unbilled: 0, unpriced: 0, disputed: 0 }
    );
  }, [summary]);

  const activeClients = useMemo(
    () => (clients ?? []).filter((c) => c.is_active),
    [clients],
  );

  const clientLabel = (id: string | null): string => {
    if (!id) return "Default (no client)";
    const row = (clients ?? []).find((c) => c.id === id);
    return row ? `${row.code}${row.name ? ` — ${row.name}` : ""}` : `${id.slice(0, 8)}…`;
  };

  return (
    <>
      <PageHeader
        title="3PL activity billing"
        description="Turn warehouse events into billable 3PL activity. Clients, tariffs, activity ledger, and month-end invoice generation."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => captureDrain.mutate()} disabled={captureDrain.isPending}>
              <RefreshCw className="h-4 w-4 mr-2" /> Capture events
            </Button>
            <Input
              type="date"
              className="w-40"
              aria-label="Storage accrual date"
              value={accrualDate}
              max={todayIso()}
              onChange={(e) => setAccrualDate(e.target.value)}
            />
            <Button
              variant="outline"
              onClick={() => accrueStorage.mutate(accrualDate)}
              disabled={accrueStorage.isPending || !accrualDate}
            >
              <CalendarClock className="h-4 w-4 mr-2" /> Accrue storage
            </Button>
            <Button variant="outline" onClick={() => setInvoiceOpen(true)}>
              <FileText className="h-4 w-4 mr-2" /> Generate invoice
            </Button>
            <Button variant="outline" onClick={() => setClientOpen(true)}>
              <Users className="h-4 w-4 mr-2" /> New client
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
                {activeClients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{clientLabel(c.id)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="min-w-0 grid grid-cols-1 @2xl/page:grid-cols-5 gap-4 mb-6">
          <KpiCard label="Activity entries" value={String(totals.entries)} />
          <KpiCard label="Billed amount" value={totals.billed.toFixed(2)} />
          <KpiCard label="Unbilled amount" value={totals.unbilled.toFixed(2)} tone={totals.unbilled > 0 ? "warn" : undefined} />
          <KpiCard label="Unpriced entries" value={String(totals.unpriced)} tone={totals.unpriced > 0 ? "bad" : undefined} />
          <KpiCard label="Disputed entries" value={String(totals.disputed)} tone={totals.disputed > 0 ? "warn" : undefined} />
        </div>

        <Section
          title="Billing clients"
          description="Each warehouse client maps to the customer record that receives the invoice."
        >
          {clientsLoading ? (
            <LoadingState />
          ) : (clients ?? []).length === 0 ? (
            <EmptyState
              title="No billing clients yet"
              description="Add a client and link it to the customer you invoice — activity cannot be priced or billed without one."
              action={<Button onClick={() => setClientOpen(true)}><Users className="h-4 w-4 mr-2" />New client</Button>}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(clients ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.code}</TableCell>
                    <TableCell>{c.name ?? "—"}</TableCell>
                    <TableCell>{c.currency ?? "Business default"}</TableCell>
                    <TableCell>
                      <Switch checked={c.is_active} onCheckedChange={() => toggleClient.mutate(c)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>

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
                  <TableHead className="text-right">Unpriced</TableHead>
                  <TableHead className="text-right">Disputed</TableHead>
                  <TableHead>Currency</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(summary ?? []).map((r, i) => (
                  <TableRow key={`${r.client_id ?? "none"}-${r.activity}-${r.uom}-${i}`}>
                    <TableCell>{clientLabel(r.client_id)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.activity}</TableCell>
                    <TableCell>{r.uom}</TableCell>
                    <TableCell className="text-right">{r.entry_count}</TableCell>
                    <TableCell className="text-right">
                      {`${Number(r.total_quantity).toFixed(2)} ${r.uom}`}
                    </TableCell>
                    <TableCell className="text-right">{Number(r.total_amount).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{Number(r.unbilled_amount).toFixed(2)}</TableCell>
                    <TableCell className="text-right">{r.unpriced_count}</TableCell>
                    <TableCell className="text-right">{r.disputed_count ?? 0}</TableCell>
                    <TableCell>{r.currency ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>

        <Section
          title="Recent entries & corrections"
          description="The ledger is immutable. Dispute holds an entry back from invoicing; reverse posts a mirrored negative entry."
        >
          {entriesLoading ? (
            <LoadingState />
          ) : (entries ?? []).length === 0 ? (
            <EmptyState
              title="No ledger entries yet"
              description="Capture events or accrue storage to populate the billing ledger."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Occurred</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(entries ?? []).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {new Date(e.occurred_at).toLocaleString()}
                    </TableCell>
                    <TableCell>{clientLabel(e.client_id)}</TableCell>
                    <TableCell className="font-mono text-xs">{e.activity}</TableCell>
                    <TableCell className="text-right">
                      {`${Number(e.quantity).toFixed(2)} ${e.uom}`}
                    </TableCell>
                    <TableCell className="text-right">
                      {e.amount === null ? "—" : `${Number(e.amount).toFixed(2)} ${e.currency ?? ""}`}
                    </TableCell>
                    <TableCell className="space-x-1">
                      {e.reverses_activity_id && <Badge variant="outline">Reversal</Badge>}
                      {e.invoice_id && <Badge variant="secondary">Invoiced</Badge>}
                      {e.disputed_at && !e.dispute_resolved_at && (
                        <Badge variant="destructive">Disputed</Badge>
                      )}
                      {e.dispute_resolved_at && <Badge variant="outline">Dispute resolved</Badge>}
                      {e.amount === null && <Badge variant="destructive">Unpriced</Badge>}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={
                          e.disputed_at && !e.dispute_resolved_at
                            ? "Resolve dispute"
                            : "Dispute entry"
                        }
                        title={e.dispute_reason ?? undefined}
                        disabled={disputeEntry.isPending || !!e.reverses_activity_id}
                        onClick={() => disputeEntry.mutate(e)}
                      >
                        <Flag className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Reverse entry"
                        disabled={reverseEntry.isPending || !!e.reverses_activity_id}
                        onClick={() => reverseEntry.mutate(e)}
                      >
                        <Undo2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
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
                  <TableHead>Band</TableHead>
                  <TableHead className="text-right">Allowance</TableHead>
                  <TableHead className="text-right">Min charge</TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(tariffs ?? []).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{clientLabel(t.client_id)}</TableCell>
                    <TableCell className="font-mono text-xs">{t.activity}</TableCell>
                    <TableCell>{t.uom}</TableCell>
                    <TableCell className="text-right">{Number(t.rate).toFixed(4)}</TableCell>
                    <TableCell className="text-xs">
                      {t.tier_from === null && t.tier_to === null
                        ? "All volumes"
                        : `${Number(t.tier_from ?? 0)} – ${t.tier_to === null ? "∞" : Number(t.tier_to)}`}
                    </TableCell>
                    <TableCell className="text-right">
                      {t.included_quantity === null ? "—" : Number(t.included_quantity)}
                    </TableCell>
                    <TableCell className="text-right">
                      {t.min_charge === null ? "—" : Number(t.min_charge).toFixed(2)}
                    </TableCell>
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

      {/* Billing client dialog */}
      <Dialog open={clientOpen} onOpenChange={setClientOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New billing client</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-2">
            <div>
              <Label>Customer to invoice</Label>
              <Select
                value={clientForm.contact_id}
                onValueChange={(v) => setClientForm((f) => ({ ...f, contact_id: v }))}
              >
                <SelectTrigger><SelectValue placeholder="Pick a customer" /></SelectTrigger>
                <SelectContent>
                  {(contacts ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 grid grid-cols-2 gap-3">
              <div>
                <Label>Client code</Label>
                <Input
                  value={clientForm.code}
                  placeholder="ACME"
                  onChange={(e) => setClientForm((f) => ({ ...f, code: e.target.value }))}
                />
              </div>
              <div>
                <Label>Billing currency (optional)</Label>
                <Select
                  value={clientForm.currency || "__default__"}
                  onValueChange={(v) => setClientForm((f) => ({ ...f, currency: v === "__default__" ? "" : v }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">Business default</SelectItem>
                    {(currencies ?? []).map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClientOpen(false)}>Cancel</Button>
            <Button onClick={() => createClient.mutate()} disabled={createClient.isPending}>
              Save client
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Tariff dialog */}
      <Dialog open={tariffOpen} onOpenChange={setTariffOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New billing tariff</DialogTitle></DialogHeader>
          <div className="grid gap-4 py-2">
            <div>
              <Label>Client (leave blank for default)</Label>
              <Select
                value={tariffForm.client_id || "__none__"}
                onValueChange={(v) => setTariffForm((f) => ({ ...f, client_id: v === "__none__" ? "" : v }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Default (no client)</SelectItem>
                  {activeClients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{clientLabel(c.id)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 grid grid-cols-2 gap-3">
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
            <div className="min-w-0 grid grid-cols-3 gap-3">
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
                <Select
                  value={tariffForm.currency}
                  onValueChange={(v) => setTariffForm((f) => ({ ...f, currency: v }))}
                >
                  <SelectTrigger><SelectValue placeholder="Currency" /></SelectTrigger>
                  <SelectContent>
                    {(currencies ?? []).map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            {/* Pricing engine: allowance is consumed first, then the tier
                band rate applies, then the minimum charge acts as a floor. */}
            <div className="min-w-0 grid grid-cols-2 gap-3">
              <div>
                <Label>Included quantity (optional)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="Free allowance per entry"
                  value={tariffForm.included_quantity}
                  onChange={(e) => setTariffForm((f) => ({ ...f, included_quantity: e.target.value }))}
                />
              </div>
              <div>
                <Label>Minimum charge (optional)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="Floor amount"
                  value={tariffForm.min_charge}
                  onChange={(e) => setTariffForm((f) => ({ ...f, min_charge: e.target.value }))}
                />
              </div>
              <div>
                <Label>Tier from (optional)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="0"
                  value={tariffForm.tier_from}
                  onChange={(e) => setTariffForm((f) => ({ ...f, tier_from: e.target.value }))}
                />
              </div>
              <div>
                <Label>Tier to (optional)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  placeholder="Unbounded"
                  value={tariffForm.tier_to}
                  onChange={(e) => setTariffForm((f) => ({ ...f, tier_to: e.target.value }))}
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
                value={invoiceForm.client_id}
                onValueChange={(v) => setInvoiceForm((f) => ({ ...f, client_id: v }))}
              >
                <SelectTrigger><SelectValue placeholder="Pick a client" /></SelectTrigger>
                <SelectContent>
                  {activeClients.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{clientLabel(c.id)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 grid grid-cols-2 gap-3">
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
              disabled={generateInvoice.isPending || !invoiceForm.client_id}
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

/**
 * RecommendationDrawer — inspects a procurement recommendation and lets the
 * planner act on it: approve, reject, assign, convert to PO, convert to
 * warehouse transfer, edit quantity, snooze, dismiss. Also renders the full
 * audit trail from `procurement_recommendation_events`.
 *
 * All writes go through security-definer RPCs (see
 * `useProcurementRecommendations`) which enforce business + branch access.
 */
import { useMemo, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  ArrowRightLeft,
  ShoppingCart,
  Clock,
  Ban,
  Pencil,
  FileText,
  CheckCircle2,
  UserCircle2,
  ShieldQuestion,
} from "lucide-react";
import {
  useProcurementRecommendations,
  useRecommendationEvents,
  humanizeRecError,
  type ProcurementRecommendation,
} from "@/hooks/useProcurementRecommendations";
import { useWarehouses } from "@/hooks/useWarehouses";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { useContacts } from "@/hooks/useContacts";
import { useGovernanceMode } from "@/hooks/governance/useGovernanceMode";
import { normalizeError } from "@/services/resilience";

interface Props {
  rec: ProcurementRecommendation | null;
  open: boolean;
  onClose: () => void;
}

const UNASSIGNED = "__unassigned__";
const KEEP_VENDOR = "__preferred__";

export function RecommendationDrawer({ rec, open, onClose }: Props) {
  const {
    snooze,
    setStatus,
    editQty,
    convertToPo,
    convertToTransfer,
    assign,
  } = useProcurementRecommendations();
  const { warehouses } = useWarehouses();
  const { members, getUserName } = useOrgMembers();
  const { contacts } = useContacts();
  const { mode: governanceMode, isSolo: soloMode } = useGovernanceMode();
  const { data: events = [] } = useRecommendationEvents(rec?.id ?? null);

  const vendors = useMemo(
    () =>
      contacts
        .filter((c) => (c.type === "supplier" || c.type === "both") && c.is_active)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [contacts],
  );

  const [poNotes, setPoNotes] = useState("");
  const [poQty, setPoQty] = useState<string>("");
  const [poVendorId, setPoVendorId] = useState<string>(KEEP_VENDOR);
  const [xfFrom, setXfFrom] = useState<string>("");
  const [xfTo, setXfTo] = useState<string>("");
  const [xfQty, setXfQty] = useState<string>("");
  const [editValue, setEditValue] = useState<string>("");
  const [editReason, setEditReason] = useState("");
  const [snoozeDays, setSnoozeDays] = useState("7");

  const effectiveQty = useMemo(() => {
    if (!rec) return 0;
    return Number(rec.edited_qty ?? rec.suggested_qty) || 0;
  }, [rec]);

  if (!rec) return null;

  const busy =
    snooze.isPending ||
    setStatus.isPending ||
    editQty.isPending ||
    convertToPo.isPending ||
    convertToTransfer.isPending ||
    assign.isPending;

  const resolvedVendorId =
    poVendorId === KEEP_VENDOR ? rec.preferred_vendor_id : poVendorId || null;
  const resolvedVendorName =
    poVendorId === KEEP_VENDOR
      ? rec.vendor?.name ?? null
      : vendors.find((v) => v.id === poVendorId)?.name ?? null;

  const err = (e: unknown) => humanizeRecError(normalizeError(e).message);

  const handleApprove = async () => {
    try {
      await setStatus.mutateAsync({ id: rec.id, status: "approved" });
      toast.success("Recommendation approved");
    } catch (e) {
      toast.error(err(e));
    }
  };
  const handleReject = async () => {
    try {
      await setStatus.mutateAsync({ id: rec.id, status: "dismissed" });
      toast.success("Recommendation rejected");
      onClose();
    } catch (e) {
      toast.error(err(e));
    }
  };
  const handleRequestReview = async () => {
    try {
      await setStatus.mutateAsync({ id: rec.id, status: "in_review" });
      toast.success("Sent for review");
    } catch (e) {
      toast.error(err(e));
    }
  };

  const handleAssign = async (userId: string) => {
    const assigneeId = userId === UNASSIGNED ? null : userId;
    try {
      await assign.mutateAsync({ id: rec.id, assigneeId });
      toast.success(assigneeId ? `Assigned to ${getUserName(assigneeId)}` : "Unassigned");
    } catch (e) {
      toast.error(err(e));
    }
  };

  const handleConvertPo = async () => {
    if (!resolvedVendorId) {
      toast.error("Pick a vendor before creating a purchase order.");
      return;
    }
    try {
      await convertToPo.mutateAsync({
        id: rec.id,
        vendorId: resolvedVendorId,
        qty: poQty ? Number(poQty) : null,
        notes: poNotes || null,
      });
      toast.success("Draft purchase order created");
      onClose();
    } catch (e) {
      toast.error(err(e));
    }
  };

  const handleConvertTransfer = async () => {
    if (!xfFrom || !xfTo) {
      toast.error("Pick source and destination warehouses");
      return;
    }
    if (xfFrom === xfTo) {
      toast.error("Source and destination warehouses must be different.");
      return;
    }
    try {
      await convertToTransfer.mutateAsync({
        id: rec.id,
        fromWarehouseId: xfFrom,
        toWarehouseId: xfTo,
        qty: xfQty ? Number(xfQty) : null,
      });
      toast.success("Draft stock transfer created");
      onClose();
    } catch (e) {
      toast.error(err(e));
    }
  };

  const handleEditQty = async () => {
    const n = Number(editValue);
    if (!Number.isFinite(n) || n < 0) {
      toast.error("Enter a valid quantity");
      return;
    }
    if (!editReason.trim()) {
      toast.error("Please explain the override");
      return;
    }
    try {
      await editQty.mutateAsync({ id: rec.id, qty: n, reason: editReason });
      toast.success("Quantity updated");
      setEditValue("");
      setEditReason("");
    } catch (e) {
      toast.error(err(e));
    }
  };

  const handleSnooze = async () => {
    const days = Math.max(1, Number(snoozeDays) || 7);
    const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    try {
      await snooze.mutateAsync({ id: rec.id, until });
      toast.success(`Snoozed for ${days} day${days === 1 ? "" : "s"}`);
      onClose();
    } catch (e) {
      toast.error(err(e));
    }
  };

  const handleDismiss = async () => {
    try {
      await setStatus.mutateAsync({ id: rec.id, status: "dismissed" });
      toast.success("Dismissed");
      onClose();
    } catch (e) {
      toast.error(err(e));
    }
  };

  const canApprove = rec.status === "open" || rec.status === "in_review";
  const canRequestReview = rec.status === "open";
  const isTerminal = ["fulfilled", "cancelled", "merged"].includes(rec.status);

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {rec.product?.name ?? "Recommendation"}
            {rec.product?.sku && (
              <span className="text-sm font-normal text-muted-foreground">
                ({rec.product.sku})
              </span>
            )}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap gap-2 items-center">
            <Badge
              variant={
                rec.urgency === "stockout" || rec.urgency === "critical"
                  ? "destructive"
                  : rec.urgency === "low"
                    ? "default"
                    : "secondary"
              }
            >
              {rec.urgency}
            </Badge>
            <Badge variant="outline">{rec.status}</Badge>
            <Badge
              variant="outline"
              className="gap-1"
              title={
                soloMode
                  ? "Solo governance mode — approvals are auto-accepted for the acting user."
                  : `Governance mode: ${governanceMode}. Approvals follow the tenant's segregation-of-duties policy.`
              }
            >
              <ShieldQuestion className="h-3 w-3" /> {governanceMode}
            </Badge>
            {rec.branch?.name && <Badge variant="outline">{rec.branch.name}</Badge>}
            {rec.assignee_id && (
              <Badge variant="outline" className="gap-1">
                <UserCircle2 className="h-3 w-3" /> {getUserName(rec.assignee_id)}
              </Badge>
            )}
            {rec.needed_by && (
              <span className="text-xs">
                Needed by {format(new Date(rec.needed_by), "MMM d, yyyy")}
              </span>
            )}
          </SheetDescription>
        </SheetHeader>

        {/* Top-level lifecycle actions — always visible, keyboard-first */}
        {!isTerminal && (
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Lifecycle actions">
            <Button size="sm" onClick={handleApprove} disabled={busy || !canApprove}>
              <CheckCircle2 className="h-4 w-4 mr-1" /> Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRequestReview}
              disabled={busy || !canRequestReview}
            >
              <ShieldQuestion className="h-4 w-4 mr-1" /> Send for review
            </Button>
            <Button size="sm" variant="ghost" onClick={handleReject} disabled={busy}>
              <Ban className="h-4 w-4 mr-1" /> Reject
            </Button>
          </div>
        )}

        <Tabs defaultValue="overview" className="mt-4">
          <TabsList className="w-full">
            <TabsTrigger value="overview" className="flex-1">Overview</TabsTrigger>
            <TabsTrigger value="actions" className="flex-1">Act</TabsTrigger>
            <TabsTrigger value="audit" className="flex-1">History</TabsTrigger>
          </TabsList>

          {/* -------- Overview -------- */}
          <TabsContent value="overview" className="space-y-4 pt-4">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <Field label="On hand" value={rec.on_hand} />
              <Field label="Reserved" value={rec.reserved} />
              <Field label="Incoming" value={rec.incoming} />
              <Field label="Velocity / week" value={round(rec.velocity_per_week)} />
              <Field label="Safety stock" value={rec.safety_stock} />
              <Field label="Lead time (d)" value={rec.lead_time_days} />
              <Field label="Net requirement" value={round(rec.net_requirement)} />
              <Field label="Suggested qty" value={effectiveQty} strong />
              <Field label="Preferred vendor" value={rec.vendor?.name ?? "—"} />
              <Field label="Suggested source" value={rec.suggested_source} />
            </div>

            <Separator />
            <div className="text-xs text-muted-foreground">
              Formula: net = max(0, safety + velocity/7 × lead − available − incoming),
              then rounded up to pack size and floored at MOQ.
            </div>

            {/* Assignment */}
            <section className="space-y-2 rounded-md border p-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <UserCircle2 className="h-4 w-4" /> Assignee
              </div>
              <Select
                value={rec.assignee_id ?? UNASSIGNED}
                onValueChange={handleAssign}
                disabled={busy}
              >
                <SelectTrigger aria-label="Assign recommendation">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name || m.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>

            {rec.linked_po_id && (
              <div className="rounded-md border p-3 text-sm bg-muted/40">
                <FileText className="inline h-4 w-4 mr-1" />
                Linked purchase order {rec.linked_po_id.slice(0, 8)}…
              </div>
            )}
            {rec.linked_transfer_id && (
              <div className="rounded-md border p-3 text-sm bg-muted/40">
                <ArrowRightLeft className="inline h-4 w-4 mr-1" />
                Linked stock transfer {rec.linked_transfer_id.slice(0, 8)}…
              </div>
            )}

            <details className="rounded-md border p-3 text-xs">
              <summary className="cursor-pointer font-medium">Explanation payload</summary>
              <dl className="mt-2 grid grid-cols-2 gap-y-1 gap-x-4">
                {Object.entries(rec.explanation || {}).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-mono">
                      {typeof v === "number" ? Math.round(v * 100) / 100 : String(v ?? "—")}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          </TabsContent>

          {/* -------- Actions -------- */}
          <TabsContent value="actions" className="space-y-6 pt-4">
            {/* Edit quantity */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Pencil className="h-4 w-4" /> Override quantity
              </h3>
              <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <div>
                  <Label htmlFor="rec-edit-qty" className="text-xs">Quantity</Label>
                  <Input
                    id="rec-edit-qty"
                    type="number"
                    min={0}
                    placeholder={`${effectiveQty}`}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="rec-edit-reason" className="text-xs">Reason</Label>
                  <Input
                    id="rec-edit-reason"
                    placeholder="Required"
                    value={editReason}
                    onChange={(e) => setEditReason(e.target.value)}
                  />
                </div>
                <div className="flex items-end">
                  <Button onClick={handleEditQty} disabled={busy}>Save</Button>
                </div>
              </div>
            </section>

            <Separator />

            {/* Convert to PO */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ShoppingCart className="h-4 w-4" /> Create draft purchase order
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="rec-po-vendor" className="text-xs">Vendor</Label>
                  <Select value={poVendorId} onValueChange={setPoVendorId}>
                    <SelectTrigger id="rec-po-vendor">
                      <SelectValue placeholder="Pick vendor" />
                    </SelectTrigger>
                    <SelectContent>
                      {rec.preferred_vendor_id && (
                        <SelectItem value={KEEP_VENDOR}>
                          {rec.vendor?.name ?? "Preferred vendor"}{" "}
                          <span className="text-xs text-muted-foreground">(preferred)</span>
                        </SelectItem>
                      )}
                      {vendors
                        .filter((v) => v.id !== rec.preferred_vendor_id)
                        .map((v) => (
                          <SelectItem key={v.id} value={v.id}>
                            {v.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="rec-po-qty" className="text-xs">Quantity</Label>
                  <Input
                    id="rec-po-qty"
                    type="number"
                    min={0}
                    placeholder={`${effectiveQty}`}
                    value={poQty}
                    onChange={(e) => setPoQty(e.target.value)}
                  />
                </div>
              </div>
              <Textarea
                aria-label="PO notes"
                placeholder="Notes (optional)"
                value={poNotes}
                onChange={(e) => setPoNotes(e.target.value)}
                rows={2}
              />
              {!resolvedVendorId && (
                <p className="text-xs text-muted-foreground">
                  Pick a vendor above (or set a preferred vendor on the reorder rule) to enable this action.
                </p>
              )}
              <Button
                onClick={handleConvertPo}
                disabled={busy || !resolvedVendorId || !!rec.linked_po_id}
                className="w-full"
              >
                Create PO{resolvedVendorName ? ` for ${resolvedVendorName}` : ""}
              </Button>
            </section>

            <Separator />

            {/* Convert to Transfer */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <ArrowRightLeft className="h-4 w-4" /> Create draft warehouse transfer
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="rec-xf-from" className="text-xs">From warehouse</Label>
                  <Select value={xfFrom} onValueChange={setXfFrom}>
                    <SelectTrigger id="rec-xf-from"><SelectValue placeholder="Source" /></SelectTrigger>
                    <SelectContent>
                      {warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="rec-xf-to" className="text-xs">To warehouse</Label>
                  <Select value={xfTo} onValueChange={setXfTo}>
                    <SelectTrigger id="rec-xf-to"><SelectValue placeholder="Destination" /></SelectTrigger>
                    <SelectContent>
                      {warehouses.map((w) => (
                        <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label htmlFor="rec-xf-qty" className="text-xs">Quantity</Label>
                <Input
                  id="rec-xf-qty"
                  type="number"
                  min={0}
                  placeholder={`${effectiveQty}`}
                  value={xfQty}
                  onChange={(e) => setXfQty(e.target.value)}
                />
              </div>
              <Button
                onClick={handleConvertTransfer}
                disabled={busy || !!rec.linked_transfer_id}
                className="w-full"
                variant="secondary"
              >
                Create transfer
              </Button>
            </section>

            <Separator />

            {/* Snooze / dismiss */}
            <section className="space-y-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Clock className="h-4 w-4" /> Defer
              </h3>
              <div className="flex items-center gap-2">
                <Label htmlFor="rec-snooze" className="text-xs whitespace-nowrap">
                  Snooze for (days)
                </Label>
                <Input
                  id="rec-snooze"
                  type="number"
                  min={1}
                  value={snoozeDays}
                  onChange={(e) => setSnoozeDays(e.target.value)}
                  className="w-24"
                />
                <Button variant="outline" onClick={handleSnooze} disabled={busy}>
                  Snooze
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleDismiss}
                  disabled={busy}
                  className="ml-auto"
                >
                  <Ban className="h-4 w-4 mr-1" /> Dismiss
                </Button>
              </div>
            </section>
          </TabsContent>

          {/* -------- Audit -------- */}
          <TabsContent value="audit" className="pt-4">
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events yet.</p>
            ) : (
              <ol className="space-y-3 text-sm">
                {events.map((e) => (
                  <li key={e.id} className="border-l-2 border-muted pl-3">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline">{e.event_type}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(e.created_at), "MMM d, HH:mm")}
                      </span>
                    </div>
                    {(e.from_status || e.to_status) && (
                      <div className="text-xs mt-1">
                        {e.from_status ?? "—"} → {e.to_status ?? "—"}
                      </div>
                    )}
                    {e.actor_id && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        by {getUserName(e.actor_id)}
                      </div>
                    )}
                    {e.note && <p className="text-xs mt-1 italic">"{e.note}"</p>}
                    {Object.keys(e.payload || {}).length > 0 && (
                      <pre className="text-[10px] mt-1 bg-muted/50 rounded p-1 overflow-x-auto">
                        {JSON.stringify(e.payload, null, 0)}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value, strong }: { label: string; value: string | number; strong?: boolean }) {
  return (
    <div className="flex justify-between border-b pb-1">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold" : "font-mono"}>{value}</span>
    </div>
  );
}

function round(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

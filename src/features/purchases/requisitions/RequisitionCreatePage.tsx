/**
 * RequisitionCreatePage — P3 Requisitions Workbench.
 *
 * Thin form over `create_purchase_requisition` RPC. The RPC allocates
 * a PR number (PR-YYYY-XXXX) and inserts lines atomically. Draft
 * requisitions do not consume any budget or emit lifecycle events
 * until submitted.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { PageBody, PageHeader, ActionBar, Section } from "@/design-system";
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
import { EditableLineItemsGrid } from "@/design-system/records/EditableLineItemsGrid";
import {
  RequisitionLineRow,
  REQUISITION_LINE_COLUMNS,
} from "@/components/documents/lines/RequisitionLineRow";
import { useToast } from "@/hooks/use-toast";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useSuppliers } from "../suppliers/useSuppliers";
import {
  createPurchaseRequisition,
  type RequisitionLineInput,
} from "./requisitionRpcs";

const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export default function RequisitionCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentBusiness } = useBusinesses();
  const { rows: suppliers, loading: suppliersLoading } = useSuppliers();

  const [needByDate, setNeedByDate] = useState<string>("");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("normal");
  const [currency, setCurrency] = useState("USD");
  const [costCenter, setCostCenter] = useState("");
  const [justification, setJustification] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<RequisitionLineInput[]>([
    { description: "", quantity: 1, estimated_unit_price: 0 },
  ]);
  const [busy, setBusy] = useState(false);

  const addLine = useCallback(
    () =>
      setLines((ls) => [
        ...ls,
        { description: "", quantity: 1, estimated_unit_price: 0 },
      ]),
    [],
  );

  const updateLine = useCallback(
    (idx: number, patch: Partial<RequisitionLineInput>) =>
      setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l))),
    [],
  );

  const removeLine = useCallback(
    (idx: number) => setLines((ls) => ls.filter((_, i) => i !== idx)),
    [],
  );

  const supplierOptions = useMemo(
    () =>
      suppliers.map((s) => ({
        id: s.id,
        label: s.contact?.name ?? s.supplier_code ?? s.id,
      })),
    [suppliers],
  );

  const estimatedTotal = lines.reduce(
    (t, l) => t + (Number(l.quantity) || 0) * (Number(l.estimated_unit_price) || 0),
    0,
  );

  async function handleSubmit() {
    if (!currentBusiness) return;
    const cleanLines = lines
      .map((l) => ({ ...l, description: (l.description || "").trim() }))
      .filter((l) => l.description.length > 0 && Number(l.quantity) > 0);
    if (cleanLines.length === 0) {
      toast({
        title: "Add at least one line",
        description: "Each line needs a description and a quantity greater than zero.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      const id = await createPurchaseRequisition({
        businessId: currentBusiness.id,
        needByDate: needByDate || null,
        priority,
        currency,
        costCenter: costCenter || null,
        justification: justification || null,
        notes: notes || null,
        lines: cleanLines,
      });
      toast({ title: "Requisition drafted" });
      navigate(`/purchases/requisitions/${id}`);
    } catch (e: any) {
      toast({
        title: "Create failed",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Purchases"
        title="New requisition"
        description="Draft an internal purchase request. It stays in Draft until you submit it for approval."
        actions={
          <ActionBar>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/purchases/requisitions")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Back
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={busy}>
              Create draft
            </Button>
          </ActionBar>
        }
      />
      <PageBody>
        <Section title="Header">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label>Need by</Label>
              <Input
                type="date"
                value={needByDate}
                onChange={(e) => setNeedByDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Currency</Label>
              <Input
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                maxLength={3}
              />
            </div>
            <div>
              <Label>Cost centre</Label>
              <Input
                value={costCenter}
                onChange={(e) => setCostCenter(e.target.value)}
                placeholder="e.g. OPS-KE"
              />
            </div>
            <div className="md:col-span-2">
              <Label>Justification</Label>
              <Input
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Why is this needed?"
              />
            </div>
          </div>
        </Section>

        <Section
          title="Lines"
          description="Items or services being requested. Approvers see the estimated total."
        >
          <EditableLineItemsGrid
            columns={REQUISITION_LINE_COLUMNS}
            rows={lines}
            onAddRow={addLine}
            onRemoveRow={removeLine}
            addLabel="Add line"
            disabled={busy}
            renderRow={(line, i, layout) => (
              <RequisitionLineRow
                key={i}
                index={i}
                item={line}
                suppliers={supplierOptions}
                suppliersLoading={suppliersLoading}
                layout={layout}
                disabled={busy}
                onPatch={updateLine}
              />
            )}
            footer={
              <div className="text-right text-sm">
                Estimated total:{" "}
                <span className="font-semibold">
                  {currency} {estimatedTotal.toFixed(2)}
                </span>
              </div>
            }
          />
        </Section>

        <Section title="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional context for approvers or buyers…"
            rows={4}
          />
        </Section>
      </PageBody>
    </>
  );
}

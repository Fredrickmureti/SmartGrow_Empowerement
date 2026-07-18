/**
 * ContractCreatePage — P2 Contracts Workbench.
 *
 * Thin form over `create_procurement_contract` RPC. Lines can be added
 * inline; each carries an optional product FK plus min/max/ceiling
 * quantities that the ceiling trigger enforces at PO time.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";

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
import { useToast } from "@/hooks/use-toast";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useSuppliers } from "../suppliers/useSuppliers";
import {
  createProcurementContract,
  type ContractLineInput,
} from "./contractRpcs";

const KINDS = [
  "master",
  "blanket",
  "framework",
  "spot",
  "service",
  "consignment",
];

export default function ContractCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentBusiness } = useBusinesses();
  const { rows: suppliers, loading: suppliersLoading } = useSuppliers();

  const [supplierId, setSupplierId] = useState<string>("");
  const [contractNumber, setContractNumber] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<string>("blanket");
  const [currency, setCurrency] = useState("USD");
  const [startDate, setStartDate] = useState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const [endDate, setEndDate] = useState<string>(
    new Date(new Date().setFullYear(new Date().getFullYear() + 1))
      .toISOString()
      .slice(0, 10),
  );
  const [ceilingValue, setCeilingValue] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<ContractLineInput[]>([]);
  const [busy, setBusy] = useState(false);

  function addLine() {
    setLines((ls) => [
      ...ls,
      {
        description: "",
        unit_price: null,
        ceiling_quantity: null,
        ceiling_value: null,
        sort_order: ls.length + 1,
      },
    ]);
  }

  function updateLine(idx: number, patch: Partial<ContractLineInput>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }

  function removeLine(idx: number) {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }

  async function handleSubmit() {
    if (!currentBusiness) return;
    if (!supplierId || !title) {
      toast({
        title: "Missing fields",
        description: "Supplier and title are required.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    try {
      const id = await createProcurementContract({
        businessId: currentBusiness.id,
        supplierId,
        contractNumber: contractNumber || null,
        title,
        kind,
        currency,
        startDate,
        endDate,
        ceilingValue: ceilingValue ? Number(ceilingValue) : null,
        lines,
        notes: notes || null,
      });
      toast({ title: "Contract created" });
      navigate(`/purchases/contracts/${id}`);
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
        title="New contract"
        description="Draft a procurement contract. It will be created in Draft and can be activated after review."
        actions={
          <ActionBar>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("/purchases/contracts")}
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label>Supplier *</Label>
              <Select value={supplierId} onValueChange={setSupplierId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      suppliersLoading ? "Loading…" : "Select supplier"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.contact?.name ?? s.supplier_code ?? s.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Contract number</Label>
              <Input
                value={contractNumber}
                onChange={(e) => setContractNumber(e.target.value)}
                placeholder="Auto if blank"
              />
            </div>
            <div className="md:col-span-2">
              <Label>Title *</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. 2026 Packaging supply agreement"
              />
            </div>
            <div>
              <Label>Kind</Label>
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k} className="capitalize">
                      {k}
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
              <Label>Start date</Label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <Label>End date</Label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <div>
              <Label>Ceiling value</Label>
              <Input
                type="number"
                value={ceilingValue}
                onChange={(e) => setCeilingValue(e.target.value)}
                placeholder="Optional cap"
              />
            </div>
          </div>
        </Section>

        <Section
          title="Lines"
          description="Optional pre-agreed items with ceilings enforced at PO time."
          actions={
            <Button variant="outline" size="sm" onClick={addLine}>
              <Plus className="mr-2 h-4 w-4" /> Add line
            </Button>
          }
        >
          {lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No lines. You can create a value-only contract without lines.
            </p>
          ) : (
            <div className="space-y-3">
              {lines.map((l, i) => (
                <div
                  key={i}
                  className="grid grid-cols-12 gap-2 items-end border rounded-md p-3"
                >
                  <div className="col-span-4">
                    <Label className="text-xs">Description</Label>
                    <Input
                      value={l.description ?? ""}
                      onChange={(e) =>
                        updateLine(i, { description: e.target.value })
                      }
                    />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs">Unit price</Label>
                    <Input
                      type="number"
                      value={l.unit_price ?? ""}
                      onChange={(e) =>
                        updateLine(i, {
                          unit_price: e.target.value
                            ? Number(e.target.value)
                            : null,
                        })
                      }
                    />
                  </div>
                  <div className="col-span-2">
                    <Label className="text-xs">Ceiling qty</Label>
                    <Input
                      type="number"
                      value={l.ceiling_quantity ?? ""}
                      onChange={(e) =>
                        updateLine(i, {
                          ceiling_quantity: e.target.value
                            ? Number(e.target.value)
                            : null,
                        })
                      }
                    />
                  </div>
                  <div className="col-span-3">
                    <Label className="text-xs">Ceiling value</Label>
                    <Input
                      type="number"
                      value={l.ceiling_value ?? ""}
                      onChange={(e) =>
                        updateLine(i, {
                          ceiling_value: e.target.value
                            ? Number(e.target.value)
                            : null,
                        })
                      }
                    />
                  </div>
                  <div className="col-span-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeLine(i)}
                      aria-label="Remove line"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="Notes">
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes, SLA references, escalation contacts…"
            rows={4}
          />
        </Section>
      </PageBody>
    </>
  );
}

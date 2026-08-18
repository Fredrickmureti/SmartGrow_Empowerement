/**
 * ContractCreatePage — P2 Contracts Workbench.
 *
 * Thin form over `create_procurement_contract` RPC. Lines can be added
 * inline; each carries an optional product FK plus min/max/ceiling
 * quantities that the ceiling trigger enforces at PO time.
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
  ContractLineRow,
  CONTRACT_LINE_COLUMNS,
} from "@/components/documents/lines/ContractLineRow";
import { useToast } from "@/hooks/use-toast";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useSuppliers } from "../suppliers/useSuppliers";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { CurrencyCombobox } from "@/components/contacts/CurrencyCombobox";
import {
  ExchangeRatePanel,
  useDescribedExchangeRate,
} from "@/components/finance/ExchangeRatePanel";
import { useProducts } from "@/hooks/useProducts";
import { Switch } from "@/components/ui/switch";
import {
  createProcurementContract,
  type ContractLineInput,
} from "./contractRpcs";

const KINDS = [
  "master",
  "framework",
  "blanket",
  "rate",
  "volume",
  "service",
  "consignment",
];

export default function ContractCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentBusiness } = useBusinesses();
  const { rows: suppliers, loading: suppliersLoading } = useSuppliers();
  const { currencies, baseCurrency } = useCurrencyContext();
  const { products } = useProducts();

  const productOptions = useMemo(
    () =>
      products
        .filter((p) => p.is_active !== false)
        .map((p) => ({ id: p.id, name: p.name, sku: p.sku, unit_price: p.unit_price })),
    [products],
  );

  const [supplierId, setSupplierId] = useState<string>("");
  const [contractNumber, setContractNumber] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<string>("blanket");
  const [currency, setCurrency] = useState(baseCurrency);
  const [tolerancePercent, setTolerancePercent] = useState("0");
  const [enforceCoverage, setEnforceCoverage] = useState(false);
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

  const addLine = useCallback(
    () =>
      setLines((ls) => [
        ...ls,
        {
          product_id: null,
          supplier_sku: null,
          description: "",
          unit_price: null,
          ceiling_quantity: null,
          ceiling_value: null,
          sort_order: ls.length + 1,
        },
      ]),
    [],
  );

  const updateLine = useCallback(
    (idx: number, patch: Partial<ContractLineInput>) =>
      setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l))),
    [],
  );

  const removeLine = useCallback(
    (idx: number) => setLines((ls) => ls.filter((_, i) => i !== idx)),
    [],
  );

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
      const result = await createProcurementContract({
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
        priceTolerancePercent: tolerancePercent ? Number(tolerancePercent) : 0,
        enforceItemCoverage: enforceCoverage,
      });
      toast({ title: "Contract created", description: `${result.contract_number} is in draft — submit it for approval.` });
      navigate(`/purchases/contracts/${result.contract_id}`);
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
              <CurrencyCombobox
                currencies={currencies}
                value={currency}
                onValueChange={setCurrency}
                placeholder="Search currency..."
              />
            </div>
            <div>
              <Label>Exchange rate</Label>
              <ExchangeRatePanel
                currency={currency}
                onDate={startDate}
                baseHint="Agreed prices are in the base currency — no conversion applies."
                missingHint="Publish or override a rate in the rate book before saving — contract ceilings cannot be valued at parity."
              />
            </div>
            <div>
              <Label>Price tolerance (%)</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={tolerancePercent}
                onChange={(e) => setTolerancePercent(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                How far a PO price may exceed the agreed price before it is blocked.
              </p>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <Label>Contract items only</Label>
                <p className="text-xs text-muted-foreground">
                  Block POs containing items not covered by a contract line.
                </p>
              </div>
              <Switch checked={enforceCoverage} onCheckedChange={setEnforceCoverage} />
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
          description="Optional pre-agreed items with ceilings enforced at PO time. Pick a catalog product to bind the line to the item master, or leave it free-text for non-catalog scope."
        >
          <EditableLineItemsGrid
            columns={CONTRACT_LINE_COLUMNS}
            rows={lines}
            onAddRow={addLine}
            onRemoveRow={removeLine}
            addLabel="Add line"
            disabled={busy}
            canRemoveRow={() => true}
            empty={
              <p className="text-sm text-muted-foreground">
                No lines. You can create a value-only contract without lines.
              </p>
            }
            renderRow={(line, i, layout) => (
              <ContractLineRow
                key={i}
                index={i}
                item={line}
                products={productOptions}
                layout={layout}
                disabled={busy}
                onPatch={updateLine}
              />
            )}
          />
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

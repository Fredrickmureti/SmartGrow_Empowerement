import { normalizeError } from "@/services/resilience";
/**
 * POSBarcodeSettings — manage product identifiers and weighted/PLU prefix
 * rules used by the POS scanner kernel.
 *
 * Two tables, two CRUD flows, no magic. CSV import and live rule preview
 * are intentionally deferred — the bus seam supports them without rework.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePOSProducts } from "@/hooks/pos/usePOSProducts";
import { writeIdentifier, retireIdentifier } from "@/features/products/identity/writeIdentifier";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2, Pencil } from "lucide-react";
import { toast } from "sonner";

const IDENTIFIER_KINDS = ["gtin", "sku", "pack", "supplier", "internal", "plu", "alias"] as const;
const RULE_KINDS = ["weighted_price", "weighted_qty", "plu"] as const;

type IdentifierRow = {
  id: string;
  product_id: string;
  code: string;
  kind: typeof IDENTIFIER_KINDS[number];
  is_primary: boolean;
  /** Phase D — packaging level binding (replaces the dropped pack_quantity). */
  packaging_id: string | null;
  packaging?: { name: string | null; qty_in_base_uom: number | null } | null;
  product?: { name: string | null; sku: string | null } | null;
};

type RuleRow = {
  id: string;
  name: string;
  prefix: string;
  kind: typeof RULE_KINDS[number];
  item_code_start: number;
  item_code_length: number;
  embedded_value_start: number | null;
  embedded_value_length: number | null;
  embedded_value_divisor: number;
  total_length: number;
  is_active: boolean;
};

export default function POSBarcodeSettings() {
  return (
    <Tabs defaultValue="identifiers" className="space-y-4">
      <TabsList>
        <TabsTrigger value="identifiers">Product identifiers</TabsTrigger>
        <TabsTrigger value="rules">Barcode rules</TabsTrigger>
      </TabsList>
      <TabsContent value="identifiers">
        <IdentifiersTab />
      </TabsContent>
      <TabsContent value="rules">
        <RulesTab />
      </TabsContent>
    </Tabs>
  );
}

/* ----------------------------- Identifiers ------------------------------ */

function IdentifiersTab() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Partial<IdentifierRow> | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["product-identifiers", currentBusiness?.id, search],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      let q = supabase
        .from("product_identifiers" as any)
        .select(
          "id, product_id, code, kind, is_primary, packaging_id, products:product_id(name, sku), packaging:packaging_id(name, qty_in_base_uom)",
        )
        .eq("business_id", currentBusiness!.id)
        .order("code")
        .limit(500);
      if (search) q = q.ilike("code", `%${search}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((r: any) => ({ ...r, product: r.products })) as IdentifierRow[];
    },
  });

  const save = useMutation({
    mutationFn: async (row: Partial<IdentifierRow>) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("No business");
      if (!row.product_id || !row.code) throw new Error("Product and code are required");
      // ADR-0110 — identifier writes go through the identity service so
      // primary-uniqueness, packaging ownership and cross-product code
      // clashes are enforced in one transaction.
      const failure = await writeIdentifier({
        businessId: currentBusiness.id,
        productId: row.product_id,
        identifierId: row.id ?? null,
        code: row.code,
        kind: row.kind ?? "gtin",
        packagingId: row.packaging_id ?? null,
        isPrimary: row.is_primary ?? false,
        source: "manual",
      });
      if (failure) throw new Error(failure);
    },
    onSuccess: () => {
      toast.success("Identifier saved");
      qc.invalidateQueries({ queryKey: ["product-identifiers"] });
      setEditing(null);
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Failed to save"),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      if (!currentBusiness?.id) throw new Error("No business");
      const failure = await retireIdentifier({ businessId: currentBusiness.id, identifierId: id });
      if (failure) throw new Error(failure);
    },
    onSuccess: () => {
      toast.success("Identifier retired");
      qc.invalidateQueries({ queryKey: ["product-identifiers"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Delete failed"),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Product identifiers</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            One product can have many codes (primary GTIN, pack barcode, supplier code, internal PLU…).
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({})}>
          <Plus className="h-4 w-4 mr-1" /> Add identifier
        </Button>
      </CardHeader>
      <CardContent>
        <Input
          placeholder="Search by code…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-3 max-w-sm"
        />
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Packaging level</TableHead>
                <TableHead>Primary</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                    No identifiers yet.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono">{r.code}</TableCell>
                    <TableCell>{r.kind}</TableCell>
                    <TableCell>{r.product?.name ?? r.product_id}</TableCell>
                    <TableCell>
                      {r.packaging
                        ? `${r.packaging.name ?? "level"} × ${r.packaging.qty_in_base_uom ?? 1}`
                        : "Base unit"}
                    </TableCell>
                    <TableCell>{r.is_primary ? "Yes" : ""}</TableCell>
                    <TableCell className="text-right">
                      <Button size="icon" variant="ghost" onClick={() => setEditing(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`Delete identifier "${r.code}"?`)) del.mutate(r.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing?.id ? "Edit identifier" : "Add identifier"}</DialogTitle>
            </DialogHeader>
            {editing && (
              <IdentifierForm
                value={editing}
                onChange={setEditing}
              />
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={() => editing && save.mutate(editing)} disabled={save.isPending}>
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function IdentifierForm({
  value,
  onChange,
}: {
  value: Partial<IdentifierRow>;
  onChange: (v: Partial<IdentifierRow>) => void;
}) {
  const { currentBusiness } = useBusinesses();
  const [productSearch, setProductSearch] = useState("");
  // Canonical product read seam — POS never queries the products table.
  const { products: catalog } = usePOSProducts();
  const products = useMemo(() => {
    const needle = productSearch.trim().toLowerCase();
    return catalog
      .filter((p) => (needle ? p.name.toLowerCase().includes(needle) : true))
      .slice(0, 20)
      .map((p) => ({ id: p.id, name: p.name, sku: p.sku }));
  }, [catalog, productSearch]);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Product</Label>
        <Input
          placeholder="Search products…"
          value={productSearch}
          onChange={(e) => setProductSearch(e.target.value)}
        />
        <Select
          value={value.product_id ?? ""}
          onValueChange={(v) => onChange({ ...value, product_id: v })}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select a product" />
          </SelectTrigger>
          <SelectContent>
            {products.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name} {p.sku ? `(${p.sku})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Code</Label>
          <Input
            value={value.code ?? ""}
            onChange={(e) => onChange({ ...value, code: e.target.value })}
            placeholder="5901234123457"
          />
        </div>
        <div className="space-y-1">
          <Label>Kind</Label>
          <Select
            value={value.kind ?? "gtin"}
            onValueChange={(v) => onChange({ ...value, kind: v as IdentifierRow["kind"] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IDENTIFIER_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Packaging level</Label>
          <p className="pt-2 text-sm text-muted-foreground">
            {value.packaging
              ? `${value.packaging.name ?? "level"} × ${value.packaging.qty_in_base_uom ?? 1}`
              : "Base unit"}{" "}
            — bind levels in Inventory → Product → Packaging.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <Switch
            checked={!!value.is_primary}
            onCheckedChange={(c) => onChange({ ...value, is_primary: c })}
          />
          <Label className="mb-1">Primary</Label>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------- Rules --------------------------------- */

function RulesTab() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Partial<RuleRow> | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["pos-barcode-rules", currentBusiness?.id],
    enabled: !!currentBusiness?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pos_barcode_rules" as any)
        .select("*")
        .eq("business_id", currentBusiness!.id)
        .order("prefix");
      if (error) throw error;
      return ((data ?? []) as unknown) as RuleRow[];
    },
  });

  const save = useMutation({
    mutationFn: async (row: Partial<RuleRow>) => {
      if (!currentOrg?.id || !currentBusiness?.id) throw new Error("No business");
      const payload = {
        name: row.name,
        prefix: row.prefix,
        kind: row.kind ?? "weighted_price",
        item_code_start: row.item_code_start ?? 2,
        item_code_length: row.item_code_length ?? 5,
        embedded_value_start: row.embedded_value_start ?? null,
        embedded_value_length: row.embedded_value_length ?? null,
        embedded_value_divisor: row.embedded_value_divisor ?? 100,
        total_length: row.total_length ?? 13,
        is_active: row.is_active ?? true,
      };
      if (row.id) {
        const { error } = await supabase
          .from("pos_barcode_rules" as any)
          .update(payload)
          .eq("id", row.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("pos_barcode_rules" as any).insert({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          ...payload,
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Rule saved");
      qc.invalidateQueries({ queryKey: ["pos-barcode-rules"] });
      setEditing(null);
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Failed to save"),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("pos_barcode_rules" as any).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Rule removed");
      qc.invalidateQueries({ queryKey: ["pos-barcode-rules"] });
    },
    onError: (e: any) => toast.error(normalizeError(e).message ?? "Delete failed"),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Weighted / PLU barcode rules</CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            EAN-13 labels printed by in-store scales (e.g. <code>2</code>-prefix with embedded price).
          </p>
        </div>
        <Button size="sm" onClick={() => setEditing({})}>
          <Plus className="h-4 w-4 mr-1" /> Add rule
        </Button>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Item window</TableHead>
                <TableHead>Embedded value</TableHead>
                <TableHead>Total len</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
                    No rules yet.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.name}</TableCell>
                    <TableCell className="font-mono">{r.prefix}</TableCell>
                    <TableCell>{r.kind}</TableCell>
                    <TableCell>
                      pos {r.item_code_start}, len {r.item_code_length}
                    </TableCell>
                    <TableCell>
                      {r.embedded_value_start
                        ? `pos ${r.embedded_value_start}, len ${r.embedded_value_length} ÷ ${r.embedded_value_divisor}`
                        : "—"}
                    </TableCell>
                    <TableCell>{r.total_length}</TableCell>
                    <TableCell>{r.is_active ? "Yes" : "No"}</TableCell>
                    <TableCell className="text-right">
                      <Button size="icon" variant="ghost" onClick={() => setEditing(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => {
                          if (confirm(`Delete rule "${r.name}"?`)) del.mutate(r.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editing?.id ? "Edit rule" : "Add rule"}</DialogTitle>
            </DialogHeader>
            {editing && <RuleForm value={editing} onChange={setEditing} />}
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={() => editing && save.mutate(editing)} disabled={save.isPending}>
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function RuleForm({
  value,
  onChange,
}: {
  value: Partial<RuleRow>;
  onChange: (v: Partial<RuleRow>) => void;
}) {
  const num = (v: string) => (v === "" ? null : Number(v));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Name</Label>
          <Input
            value={value.name ?? ""}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
            placeholder="Weighted price (deli)"
          />
        </div>
        <div className="space-y-1">
          <Label>Prefix</Label>
          <Input
            value={value.prefix ?? ""}
            onChange={(e) => onChange({ ...value, prefix: e.target.value })}
            placeholder="2"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Kind</Label>
          <Select
            value={value.kind ?? "weighted_price"}
            onValueChange={(v) => onChange({ ...value, kind: v as RuleRow["kind"] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Total length</Label>
          <Input
            type="number"
            value={value.total_length ?? 13}
            onChange={(e) => onChange({ ...value, total_length: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Item code start (1-based)</Label>
          <Input
            type="number"
            value={value.item_code_start ?? 2}
            onChange={(e) => onChange({ ...value, item_code_start: Number(e.target.value) })}
          />
        </div>
        <div className="space-y-1">
          <Label>Item code length</Label>
          <Input
            type="number"
            value={value.item_code_length ?? 5}
            onChange={(e) => onChange({ ...value, item_code_length: Number(e.target.value) })}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label>Embedded value start</Label>
          <Input
            type="number"
            value={value.embedded_value_start ?? ""}
            onChange={(e) =>
              onChange({ ...value, embedded_value_start: num(e.target.value) })
            }
          />
        </div>
        <div className="space-y-1">
          <Label>Embedded value length</Label>
          <Input
            type="number"
            value={value.embedded_value_length ?? ""}
            onChange={(e) =>
              onChange({ ...value, embedded_value_length: num(e.target.value) })
            }
          />
        </div>
        <div className="space-y-1">
          <Label>Divisor</Label>
          <Input
            type="number"
            value={value.embedded_value_divisor ?? 100}
            onChange={(e) =>
              onChange({ ...value, embedded_value_divisor: Number(e.target.value) })
            }
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={value.is_active ?? true}
          onCheckedChange={(c) => onChange({ ...value, is_active: c })}
        />
        <Label>Active</Label>
      </div>
    </div>
  );
}

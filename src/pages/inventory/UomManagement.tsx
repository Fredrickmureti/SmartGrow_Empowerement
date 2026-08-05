/**
 * UoM Management — CRUD over uom_categories and units_of_measure.
 *
 * Phase R5 of the UoM/Packaging audit. Lets admins define unit categories
 * (e.g. "Weight", "Length", "Count") and the units inside them, including
 * each unit's factor against the category's reference unit. The pickers
 * across products (UomSelect) and packaging (PackagingSelect) read from
 * these tables, so this page is the canonical mutation surface.
 *
 * Scoping: every row is org+business scoped. RLS enforces visibility.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ConfirmDeleteDialog } from "@/components/shared/ConfirmDeleteDialog";
import { DetailSheet, FieldGrid, FooterActionBar } from "@/design-system";
import { Plus, Pencil, Trash2, Ruler, Scale } from "lucide-react";

type UomCategory = {
  id: string;
  name: string;
  reference_uom_id: string | null;
};

type UnitOfMeasure = {
  id: string;
  category_id: string;
  code: string;
  name: string;
  factor_to_reference: number;
  rounding: number;
  uom_type: "reference" | "bigger" | "smaller";
  is_active: boolean;
};

export default function UomManagement() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const orgId = currentOrg?.id;
  const bizId = currentBusiness?.id;
  const qc = useQueryClient();
  const { toast } = useToast();

  const [categoryDialogOpen, setCategoryDialogOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<UomCategory | null>(null);
  const [categoryName, setCategoryName] = useState("");

  const [unitDialogOpen, setUnitDialogOpen] = useState(false);
  const [editingUnit, setEditingUnit] = useState<UnitOfMeasure | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>("");
  const [unitForm, setUnitForm] = useState<{
    code: string; name: string; factor: string; rounding: string;
    uom_type: "reference" | "bigger" | "smaller"; is_active: boolean;
  }>({
    code: "", name: "", factor: "1", rounding: "1",
    uom_type: "reference", is_active: true,
  });
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState<UomCategory | null>(null);
  const [deleteUnitTarget, setDeleteUnitTarget] = useState<UnitOfMeasure | null>(null);

  const enabled = !!orgId && !!bizId;

  const { data: categories = [] } = useQuery({
    queryKey: ["uom-categories", orgId, bizId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("uom_categories")
        .select("id, name, reference_uom_id")
        .eq("organization_id", orgId!)
        .eq("business_id", bizId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as UomCategory[];
    },
  });

  const { data: units = [] } = useQuery({
    queryKey: ["units-of-measure-admin", orgId, bizId],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("units_of_measure")
        .select("id, category_id, code, name, factor_to_reference, rounding, uom_type, is_active")
        .eq("organization_id", orgId!)
        .eq("business_id", bizId!)
        .order("category_id")
        .order("factor_to_reference");
      if (error) throw error;
      return (data ?? []) as UnitOfMeasure[];
    },
  });

  const unitsByCategory = useMemo(() => {
    const m = new Map<string, UnitOfMeasure[]>();
    for (const u of units) {
      const arr = m.get(u.category_id) ?? [];
      arr.push(u);
      m.set(u.category_id, arr);
    }
    return m;
  }, [units]);

  // ---------- Category mutations ----------
  const saveCategory = useMutation({
    mutationFn: async () => {
      if (!orgId || !bizId) throw new Error("No active business");
      const name = categoryName.trim();
      if (!name) throw new Error("Name is required");
      if (editingCategory) {
        const { error } = await supabase
          .from("uom_categories")
          .update({ name })
          .eq("id", editingCategory.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("uom_categories")
          .insert({ organization_id: orgId, business_id: bizId, name });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["uom-categories"] });
      toast({ title: editingCategory ? "Category updated" : "Category created" });
      setCategoryDialogOpen(false);
      setEditingCategory(null);
      setCategoryName("");
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const deleteCategory = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("uom_categories").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["uom-categories"] });
      qc.invalidateQueries({ queryKey: ["units-of-measure-admin"] });
      toast({ title: "Category deleted" });
    },
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // ---------- Unit mutations ----------
  const saveUnit = useMutation({
    mutationFn: async () => {
      if (!orgId || !bizId) throw new Error("No active business");
      if (!selectedCategoryId) throw new Error("Pick a category");
      const code = unitForm.code.trim();
      const name = unitForm.name.trim();
      if (!code || !name) throw new Error("Code and name are required");
      const factor = Number(unitForm.factor);
      const rounding = Number(unitForm.rounding);
      if (!Number.isFinite(factor) || factor <= 0) throw new Error("Factor must be > 0");
      if (!Number.isFinite(rounding) || rounding <= 0) throw new Error("Rounding must be > 0");
      const payload = {
        category_id: selectedCategoryId,
        code, name,
        factor_to_reference: factor,
        rounding,
        uom_type: unitForm.uom_type,
        is_active: unitForm.is_active,
      };
      if (editingUnit) {
        const { error } = await supabase
          .from("units_of_measure")
          .update(payload)
          .eq("id", editingUnit.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("units_of_measure")
          .insert({ organization_id: orgId, business_id: bizId, ...payload });
        if (error) throw error;
      }
    },
    onSuccess: async () => {
      qc.invalidateQueries({ queryKey: ["units-of-measure-admin"] });
      qc.invalidateQueries({ queryKey: ["units-of-measure"] });
      // If user created the reference unit, point the category at it.
      if (!editingUnit && unitForm.uom_type === "reference") {
        const cat = categories.find((c) => c.id === selectedCategoryId);
        if (cat && !cat.reference_uom_id) {
          const { data } = await supabase
            .from("units_of_measure")
            .select("id")
            .eq("category_id", selectedCategoryId)
            .eq("code", unitForm.code.trim())
            .maybeSingle();
          if (data?.id) {
            await supabase
              .from("uom_categories")
              .update({ reference_uom_id: data.id })
              .eq("id", selectedCategoryId);
            qc.invalidateQueries({ queryKey: ["uom-categories"] });
          }
        }
      }
      toast({ title: editingUnit ? "Unit updated" : "Unit created" });
      setUnitDialogOpen(false);
      setEditingUnit(null);
    },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const deleteUnit = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("units_of_measure").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["units-of-measure-admin"] });
      qc.invalidateQueries({ queryKey: ["units-of-measure"] });
      toast({ title: "Unit deleted" });
    },
    onError: (e: any) => toast({ title: "Delete failed", description: e.message, variant: "destructive" }),
  });

  // ---------- Dialog openers ----------
  const openCreateCategory = () => {
    setEditingCategory(null);
    setCategoryName("");
    setCategoryDialogOpen(true);
  };
  const openEditCategory = (c: UomCategory) => {
    setEditingCategory(c);
    setCategoryName(c.name);
    setCategoryDialogOpen(true);
  };
  const openCreateUnit = (categoryId: string) => {
    setEditingUnit(null);
    setSelectedCategoryId(categoryId);
    const cat = categories.find((c) => c.id === categoryId);
    const hasReference = (unitsByCategory.get(categoryId) ?? []).some((u) => u.uom_type === "reference");
    setUnitForm({
      code: "",
      name: "",
      factor: "1",
      rounding: "1",
      uom_type: hasReference || cat?.reference_uom_id ? "bigger" : "reference",
      is_active: true,
    });
    setUnitDialogOpen(true);
  };
  const openEditUnit = (u: UnitOfMeasure) => {
    setEditingUnit(u);
    setSelectedCategoryId(u.category_id);
    setUnitForm({
      code: u.code,
      name: u.name,
      factor: String(u.factor_to_reference),
      rounding: String(u.rounding),
      uom_type: u.uom_type,
      is_active: u.is_active,
    });
    setUnitDialogOpen(true);
  };

  if (!enabled) {
    return (
      <div className="p-6 text-muted-foreground">Pick a business to manage units of measure.</div>
    );
  }

  return (
    <div className="w-full min-w-0 px-1 py-2 sm:px-2 md:px-4 md:py-4 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Scale className="h-6 w-6" /> Units of Measure
          </h1>
          <p className="text-muted-foreground">
            Define unit categories (Weight, Length, Count…) and the units in each.
            Each non-reference unit declares how many reference units it represents.
          </p>
        </div>
        <Button onClick={openCreateCategory} className="shrink-0">
          <Plus className="h-4 w-4 mr-2" /> New Category
        </Button>
      </div>

      {categories.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            No UoM categories yet. Start by creating one (e.g. "Count" with a reference unit "ea").
          </CardContent>
        </Card>
      )}

      {categories.map((cat) => {
        const items = unitsByCategory.get(cat.id) ?? [];
        const ref = items.find((u) => u.id === cat.reference_uom_id) ?? items.find((u) => u.uom_type === "reference");
        return (
          <Card key={cat.id}>
            <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <CardTitle className="flex flex-wrap items-center gap-2">
                  <Ruler className="h-4 w-4" /> {cat.name}
                  {ref && <Badge variant="secondary">Reference: {ref.code}</Badge>}
                </CardTitle>
                <CardDescription>
                  {items.length} unit{items.length === 1 ? "" : "s"}
                </CardDescription>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button size="sm" variant="outline" onClick={() => openCreateUnit(cat.id)}>
                  <Plus className="h-4 w-4 mr-1" /> Add unit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openEditCategory(cat)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleteCategoryTarget(cat)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="min-w-0">
              {items.length === 0 ? (
                <div className="text-sm text-muted-foreground">No units yet — add a reference unit first.</div>
              ) : (
                <div className="w-full overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Factor → Reference</TableHead>
                      <TableHead className="text-right">Rounding</TableHead>
                      <TableHead>Active</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((u) => (
                      <TableRow key={u.id}>
                        <TableCell className="font-mono">{u.code}</TableCell>
                        <TableCell>{u.name}</TableCell>
                        <TableCell>
                          <Badge variant={u.uom_type === "reference" ? "default" : "outline"}>
                            {u.uom_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{u.factor_to_reference}</TableCell>
                        <TableCell className="text-right tabular-nums">{u.rounding}</TableCell>
                        <TableCell>{u.is_active ? "Yes" : "No"}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => openEditUnit(u)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeleteUnitTarget(u)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        );
      })}

      <DetailSheet
        open={categoryDialogOpen}
        onOpenChange={setCategoryDialogOpen}
        size="sm"
        title={editingCategory ? "Edit Category" : "New UoM Category"}
        description="Categories group commensurable units, such as all weight units converting into kilograms."
        footer={
          <FooterActionBar
            anchor="sheet"
            leading={<Button variant="ghost" onClick={() => setCategoryDialogOpen(false)}>Cancel</Button>}
            trailing={
              <Button onClick={() => saveCategory.mutate()} disabled={saveCategory.isPending}>
                {editingCategory ? "Save" : "Create"}
              </Button>
            }
          />
        }
      >
        <div className="space-y-2">
          <Label>Name</Label>
          <Input
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
            placeholder="e.g. Weight, Length, Count"
          />
        </div>
      </DetailSheet>

      <DetailSheet
        open={unitDialogOpen}
        onOpenChange={setUnitDialogOpen}
        size="md"
        title={editingUnit ? "Edit Unit" : "New Unit of Measure"}
        description="Reference units use factor 1; bigger and smaller units declare their conversion against that reference."
        footer={
          <FooterActionBar
            anchor="sheet"
            leading={<Button variant="ghost" onClick={() => setUnitDialogOpen(false)}>Cancel</Button>}
            trailing={
              <Button onClick={() => saveUnit.mutate()} disabled={saveUnit.isPending}>
                {editingUnit ? "Save" : "Create"}
              </Button>
            }
          />
        }
      >
        <FieldGrid columns={2}>
          <div className="space-y-1 sm:col-span-2">
            <Label>Category</Label>
            <Select value={selectedCategoryId} onValueChange={setSelectedCategoryId} disabled={!!editingUnit}>
              <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Code</Label>
            <Input
              value={unitForm.code}
              onChange={(e) => setUnitForm((s) => ({ ...s, code: e.target.value }))}
              placeholder="kg"
            />
          </div>
          <div className="space-y-1">
            <Label>Name</Label>
            <Input
              value={unitForm.name}
              onChange={(e) => setUnitForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="Kilogram"
            />
          </div>
          <div className="space-y-1">
            <Label>Type</Label>
            <Select
              value={unitForm.uom_type}
              onValueChange={(v: "reference" | "bigger" | "smaller") =>
                setUnitForm((s) => ({
                  ...s,
                  uom_type: v,
                  factor: v === "reference" ? "1" : s.factor,
                }))
              }
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="reference">Reference</SelectItem>
                <SelectItem value="bigger">Bigger than reference</SelectItem>
                <SelectItem value="smaller">Smaller than reference</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Factor to reference</Label>
            <Input
              type="number"
              step="any"
              value={unitForm.factor}
              onChange={(e) => setUnitForm((s) => ({ ...s, factor: e.target.value }))}
              disabled={unitForm.uom_type === "reference"}
            />
          </div>
          <div className="space-y-1">
            <Label>Rounding</Label>
            <Input
              type="number"
              step="any"
              value={unitForm.rounding}
              onChange={(e) => setUnitForm((s) => ({ ...s, rounding: e.target.value }))}
            />
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Switch
              checked={unitForm.is_active}
              onCheckedChange={(v) => setUnitForm((s) => ({ ...s, is_active: v }))}
            />
            <Label>Active</Label>
          </div>
        </FieldGrid>
      </DetailSheet>

      <ConfirmDeleteDialog
        open={!!deleteCategoryTarget}
        onOpenChange={(o) => !o && setDeleteCategoryTarget(null)}
        title={deleteCategoryTarget ? `Delete category "${deleteCategoryTarget.name}"?` : "Delete category"}
        description="Units inside this category will also be deleted. Products using them will lose their UoM reference."
        onConfirm={() => {
          if (deleteCategoryTarget) deleteCategory.mutate(deleteCategoryTarget.id);
          setDeleteCategoryTarget(null);
        }}
        isLoading={deleteCategory.isPending}
      />
      <ConfirmDeleteDialog
        open={!!deleteUnitTarget}
        onOpenChange={(o) => !o && setDeleteUnitTarget(null)}
        title={deleteUnitTarget ? `Delete unit "${deleteUnitTarget.name}"?` : "Delete unit"}
        description="Products using this unit will lose their UoM reference."
        onConfirm={() => {
          if (deleteUnitTarget) deleteUnit.mutate(deleteUnitTarget.id);
          setDeleteUnitTarget(null);
        }}
        isLoading={deleteUnit.isPending}
      />
    </div>
  );
}

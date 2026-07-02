// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Pencil, Trash2, BookOpen } from "lucide-react";
import { normalizeError } from "@/services/resilience";

interface CatalogFeature {
  id: string;
  feature_key: string;
  label: string;
  category: string;
  description: string | null;
  sort_order: number;
  created_at: string;
}

const CATEGORIES = [
  { value: "core", label: "Core Features" },
  { value: "pos", label: "Point of Sale" },
  { value: "reports", label: "Reports" },
  { value: "advanced", label: "Advanced Features" },
  { value: "operations", label: "Operations & HR" },
  { value: "sales", label: "Sales Documents" },
  { value: "purchasing", label: "Purchasing" },
  { value: "intelligence", label: "Intelligence" },
  { value: "limits", label: "Usage Limits" },
  { value: "erp", label: "ERP Suite" },
  { value: "extras", label: "Extras" },
];

const EMPTY_FORM = {
  feature_key: "",
  label: "",
  category: "core",
  description: "",
  sort_order: 0,
};

export function FeatureCatalogSettings() {
  const { toast } = useToast();
  const [features, setFeatures] = useState<CatalogFeature[]>([]);
  const [planCounts, setPlanCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingFeature, setEditingFeature] = useState<CatalogFeature | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await (supabase.from as any)("platform_feature_catalog")
        .select("*")
        .order("category")
        .order("sort_order");
      if (error) throw error;
      setFeatures(data || []);

      // Count how many plans have each feature enabled
      const { data: pfa } = await (supabase.from as any)("plan_feature_access")
        .select("feature_key")
        .eq("is_enabled", true);
      const counts: Record<string, number> = {};
      (pfa || []).forEach((r: any) => {
        counts[r.feature_key] = (counts[r.feature_key] || 0) + 1;
      });
      setPlanCounts(counts);
    } catch (error: any) {
      console.error("Error fetching feature catalog:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const openCreate = () => {
    setEditingFeature(null);
    setForm({ ...EMPTY_FORM, sort_order: features.length });
    setDialogOpen(true);
  };

  const openEdit = (feature: CatalogFeature) => {
    setEditingFeature(feature);
    setForm({
      feature_key: feature.feature_key,
      label: feature.label,
      category: feature.category,
      description: feature.description || "",
      sort_order: feature.sort_order,
    });
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!form.feature_key || !form.label) {
      toast({ title: "Validation error", description: "Key and label are required.", variant: "destructive" });
      return;
    }
    setIsSaving(true);
    try {
      if (editingFeature) {
        const { error } = await (supabase.from as any)("platform_feature_catalog")
          .update({
            label: form.label,
            category: form.category,
            description: form.description || null,
            sort_order: form.sort_order,
          })
          .eq("id", editingFeature.id);
        if (error) throw error;
        toast({ title: "Feature updated" });
      } else {
        const { error } = await (supabase.from as any)("platform_feature_catalog")
          .insert({
            feature_key: form.feature_key,
            label: form.label,
            category: form.category,
            description: form.description || null,
            sort_order: form.sort_order,
          });
        if (error) throw error;
        toast({ title: "Feature created" });
      }
      setDialogOpen(false);
      await fetchData();
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (feature: CatalogFeature) => {
    if (!confirm(`Delete feature "${feature.label}"? This will also remove it from all plan configurations.`)) return;
    try {
      const { error } = await (supabase.from as any)("platform_feature_catalog")
        .delete()
        .eq("id", feature.id);
      if (error) throw error;
      toast({ title: "Feature deleted" });
      await fetchData();
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const getCategoryLabel = (cat: string) =>
    CATEGORIES.find((c) => c.value === cat)?.label || cat;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Group by category for display
  const grouped = features.reduce<Record<string, CatalogFeature[]>>((acc, f) => {
    if (!acc[f.category]) acc[f.category] = [];
    acc[f.category].push(f);
    return acc;
  }, {});

  return (
    <>
      <Card>
        <CardHeader className="p-4 sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                <BookOpen className="h-5 w-5" />
                Feature Catalog
              </CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                Manage the master list of platform features. Features defined here can be toggled per plan in the Feature Access tab.
              </CardDescription>
            </div>
            <Button onClick={openCreate} size="sm">
              <Plus className="mr-1.5 h-4 w-4" />
              Add Feature
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-4 sm:p-6 pt-0 sm:pt-0">
          {Object.entries(grouped).map(([category, catFeatures]) => (
            <div key={category} className="mb-6 last:mb-0">
              <h4 className="font-medium text-xs sm:text-sm text-muted-foreground uppercase tracking-wide mb-2">
                {getCategoryLabel(category)}
              </h4>
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Key</TableHead>
                      <TableHead className="text-xs">Label</TableHead>
                      <TableHead className="text-xs hidden sm:table-cell">Plans</TableHead>
                      <TableHead className="text-xs hidden md:table-cell">Description</TableHead>
                      <TableHead className="text-xs w-20">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {catFeatures.map((feature) => (
                      <TableRow key={feature.id}>
                        <TableCell className="font-mono text-xs">{feature.feature_key}</TableCell>
                        <TableCell className="text-sm font-medium">{feature.label}</TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <Badge variant="secondary" className="text-xs">
                            {planCounts[feature.feature_key] || 0} plans
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground hidden md:table-cell truncate max-w-48">
                          {feature.description || "—"}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(feature)}>
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => handleDelete(feature)}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))}
          {features.length === 0 && (
            <div className="text-center py-8 text-muted-foreground text-sm">
              No features in catalog. Click "Add Feature" to create the first one.
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingFeature ? "Edit Feature" : "Add Feature"}</DialogTitle>
            <DialogDescription>
              {editingFeature
                ? "Update feature details. The feature key cannot be changed."
                : "Define a new feature for the platform catalog."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Feature Key</Label>
              <Input
                placeholder="e.g. recurring_invoices"
                value={form.feature_key}
                onChange={(e) => setForm({ ...form, feature_key: e.target.value })}
                disabled={!!editingFeature}
                className="mt-1 font-mono text-sm"
              />
            </div>
            <div>
              <Label className="text-xs">Display Label</Label>
              <Input
                placeholder="e.g. Recurring Invoices"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((cat) => (
                    <SelectItem key={cat.value} value={cat.value}>
                      {cat.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Description</Label>
              <Textarea
                placeholder="Optional description"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="mt-1"
                rows={2}
              />
            </div>
            <div>
              <Label className="text-xs">Sort Order</Label>
              <Input
                type="number"
                value={form.sort_order}
                onChange={(e) => setForm({ ...form, sort_order: parseInt(e.target.value) || 0 })}
                className="mt-1 w-24"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingFeature ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

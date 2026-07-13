// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

export function FeatureCatalogSettings() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [features, setFeatures] = useState<CatalogFeature[]>([]);
  const [planCounts, setPlanCounts] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(true);

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

  const openCreate = () =>
    navigate("/admin-management/plan-builder/features/new");
  const openEdit = (feature: CatalogFeature) =>
    navigate(`/admin-management/plan-builder/features/${feature.id}/edit`);

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
    </>
  );
}

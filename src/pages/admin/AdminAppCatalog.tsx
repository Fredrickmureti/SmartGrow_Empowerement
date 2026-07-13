import { normalizeError } from "@/services/resilience";
/**
 * Admin App Catalog Page
 * 
 * Platform admin interface for managing the app catalog.
 * Controls which apps are available, visible in signup, core vs optional.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Package, ShieldCheck, Pencil } from "lucide-react";
import { getAppById } from "@/lib/apps/registry";

interface PlatformApp {
  id: string;
  name: string;
  description: string | null;
  category: string;
  required_plan: string;
  is_available: boolean;
  is_core: boolean;
  is_free_trial: boolean;
  is_visible_in_signup: boolean;
  trial_days: number | null;
  sort_order: number;
}

const CATEGORY_OPTIONS = [
  { value: "core", label: "Core" },
  { value: "operations", label: "Operations" },
  { value: "analytics", label: "Analytics" },
  { value: "productivity", label: "Productivity" },
  { value: "integrations", label: "Integrations" },
  { value: "platform", label: "Platform" },
];

const PLAN_OPTIONS = [
  { value: "starter", label: "Starter" },
  { value: "professional", label: "Professional" },
  { value: "enterprise", label: "Enterprise" },
];

export default function AdminAppCatalog() {
  const queryClient = useQueryClient();

  const { data: apps = [], isLoading } = useQuery({
    queryKey: ["admin-app-catalog"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("platform_apps")
        .select("*")
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return data as PlatformApp[];
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, field, value }: { id: string; field: string; value: any }) => {
      const updatePayload: Record<string, any> = { [field]: value, updated_at: new Date().toISOString() };
      const { error } = await (supabase.from("platform_apps") as any)
        .update(updatePayload)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-app-catalog"] });
      toast.success("App catalog updated");
    },
    onError: (err: any) => {
      toast.error(`Update failed: ${normalizeError(err).message}`);
    },
  });

  const handleToggle = (id: string, field: string, value: boolean) => {
    updateMutation.mutate({ id, field, value });
  };

  const handleSelect = (id: string, field: string, value: string) => {
    updateMutation.mutate({ id, field, value });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Package className="h-6 w-6" />
          App Catalog
        </h1>
        <p className="text-muted-foreground mt-1">
          Control which apps are available to organizations, visible during signup, and marked as core.
        </p>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span><strong>Core</strong> — auto-installed, cannot be uninstalled</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded bg-primary/20 border border-primary/40" />
          <span><strong>Available</strong> — visible in marketplace</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-4 h-4 rounded bg-accent/40 border border-accent" />
          <span><strong>Signup</strong> — shown during onboarding</span>
        </div>
      </div>

      {/* Table */}
      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[200px]">App</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead className="text-center">Available</TableHead>
              <TableHead className="text-center">Signup</TableHead>
              <TableHead className="text-center">Core</TableHead>
              <TableHead className="text-center">Order</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((app) => {
              const registryApp = getAppById(app.id);
              const Icon = registryApp?.icon;
              const color = registryApp?.color;
              
              return (
                <TableRow key={app.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {Icon && (
                        <Icon
                          className="h-4 w-4 shrink-0"
                          style={color ? { color } : undefined}
                        />
                      )}
                      <div>
                        <span className="font-medium text-sm">{app.name}</span>
                        {app.is_core && (
                          <Badge variant="secondary" className="ml-2 text-[10px] py-0">
                            Core
                          </Badge>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={app.category}
                      onValueChange={(v) => handleSelect(app.id, "category", v)}
                    >
                      <SelectTrigger className="h-8 w-[130px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORY_OPTIONS.map(o => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={app.required_plan}
                      onValueChange={(v) => handleSelect(app.id, "required_plan", v)}
                    >
                      <SelectTrigger className="h-8 w-[120px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PLAN_OPTIONS.map(o => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={app.is_available}
                      onCheckedChange={(v) => handleToggle(app.id, "is_available", v)}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={app.is_visible_in_signup}
                      onCheckedChange={(v) => handleToggle(app.id, "is_visible_in_signup", v)}
                    />
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={app.is_core}
                      onCheckedChange={(v) => handleToggle(app.id, "is_core", v)}
                    />
                  </TableCell>
                  <TableCell className="text-center text-sm text-muted-foreground">
                    {app.sort_order}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// @ts-nocheck
/**
 * OrgEntitlementOverrides — list of per-organization entitlement
 * exceptions. Create/edit route to dedicated workspace pages per the
 * Platform Admin four-pattern rule. This component owns only the list,
 * the active toggle, and a confirm-based delete.
 */
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, Shield, Zap, Package, AlertTriangle, Pencil } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";

interface Override {
  id: string;
  organization_id: string;
  override_type: "feature" | "app" | "limit";
  key: string;
  override_value: any;
  reason: string | null;
  granted_by: string | null;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
}

interface OrgEntitlementOverridesProps {
  organizationId: string;
  organizationName: string;
}

const OVERRIDE_TYPE_ICONS = {
  feature: <Zap className="h-4 w-4" />,
  app: <Package className="h-4 w-4" />,
  limit: <AlertTriangle className="h-4 w-4" />,
};

export function OrgEntitlementOverrides({ organizationId, organizationName }: OrgEntitlementOverridesProps) {
  const navigate = useNavigate();
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Override | null>(null);

  const fetchOverrides = async () => {
    setLoading(true);
    const { data, error } = await (supabase.from as any)("org_entitlement_overrides")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });

    if (!error && data) setOverrides(data);
    setLoading(false);
  };

  useEffect(() => {
    fetchOverrides();
  }, [organizationId]);

  const toggleActive = async (id: string, currentActive: boolean) => {
    const { error } = await (supabase.from as any)("org_entitlement_overrides")
      .update({ is_active: !currentActive, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) toast.error(normalizeError(error).message);
    else fetchOverrides();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { error } = await (supabase.from as any)("org_entitlement_overrides")
      .delete()
      .eq("id", deleteTarget.id);
    if (error) toast.error(normalizeError(error).message);
    else {
      toast.success("Override removed");
      fetchOverrides();
    }
    setDeleteTarget(null);
  };

  const formatValue = (override: Override) => {
    if (override.override_type === "limit") {
      const val = override.override_value?.value ?? override.override_value;
      return `Limit: ${val}`;
    }
    const val = typeof override.override_value === "boolean"
      ? override.override_value
      : String(override.override_value) === "true";
    return val ? "Granted" : "Revoked";
  };

  const basePath = `/admin-management/organizations/${organizationId}/entitlements`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Entitlement Overrides
          </CardTitle>
          <CardDescription>
            Per-organization entitlement exceptions for {organizationName}
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => navigate(`${basePath}/new`)}>
          <Plus className="h-4 w-4 mr-1" /> Add override
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : overrides.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No overrides configured. This organization uses plan defaults only.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overrides.map(o => (
                <TableRow key={o.id} className={!o.is_active ? "opacity-50" : ""}>
                  <TableCell>
                    <Badge variant="outline" className="flex items-center gap-1 w-fit">
                      {OVERRIDE_TYPE_ICONS[o.override_type]}
                      {o.override_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-sm">{o.key}</TableCell>
                  <TableCell>
                    <Badge variant={formatValue(o) === "Revoked" ? "destructive" : "default"}>
                      {formatValue(o)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate">
                    {o.reason || "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {o.expires_at ? format(new Date(o.expires_at), "MMM d, yyyy") : "Never"}
                  </TableCell>
                  <TableCell>
                    <Switch checked={o.is_active} onCheckedChange={() => toggleActive(o.id, o.is_active)} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => navigate(`${basePath}/${o.id}/edit`)}
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleteTarget(o)}
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove entitlement override</AlertDialogTitle>
            <AlertDialogDescription>
              This organization will fall back to plan defaults for
              <span className="font-mono mx-1">{deleteTarget?.key}</span>.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

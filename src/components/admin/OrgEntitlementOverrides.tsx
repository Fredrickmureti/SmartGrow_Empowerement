// @ts-nocheck
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, Shield, Zap, Package, AlertTriangle } from "lucide-react";
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
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [knownKeys, setKnownKeys] = useState<{ features: { key: string; label: string }[]; apps: string[] }>({ features: [], apps: [] });
  const [useCustomKey, setUseCustomKey] = useState(false);
  const [newOverride, setNewOverride] = useState({
    override_type: "feature" as "feature" | "app" | "limit",
    key: "",
    override_value: "true",
    reason: "",
    expires_at: "",
  });

  const fetchOverrides = async () => {
    setLoading(true);
    const { data, error } = await (supabase.from as any)("org_entitlement_overrides")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });

    if (!error && data) setOverrides(data);
    setLoading(false);
  };

  const fetchKnownKeys = async () => {
    // Fetch feature keys from platform_feature_catalog
    const { data: featureData } = await (supabase.from as any)("platform_feature_catalog")
      .select("feature_key, label")
      .order("label");
    
    // Fetch distinct app IDs from plan_app_access
    const { data: appData } = await (supabase.from as any)("plan_app_access")
      .select("app_id");
    
    const uniqueApps = [...new Set((appData || []).map((a: any) => a.app_id))].sort() as string[];
    
    setKnownKeys({
      features: (featureData || []).map((f: any) => ({ key: f.feature_key, label: f.label })),
      apps: uniqueApps,
    });
  };

  useEffect(() => {
    fetchOverrides();
    fetchKnownKeys();
  }, [organizationId]);

  const handleAdd = async () => {
    if (!newOverride.key.trim()) {
      toast.error("Key is required");
      return;
    }

    let overrideValue: any;
    if (newOverride.override_type === "limit") {
      overrideValue = { value: parseInt(newOverride.override_value, 10) };
    } else {
      overrideValue = newOverride.override_value === "false" ? false : true;
    }

    const { error } = await (supabase.from as any)("org_entitlement_overrides").insert({
      organization_id: organizationId,
      override_type: newOverride.override_type,
      key: newOverride.key.trim(),
      override_value: overrideValue,
      reason: newOverride.reason || null,
      expires_at: newOverride.expires_at || null,
      granted_by: (await supabase.auth.getUser()).data.user?.id,
    });

    if (error) {
      toast.error(normalizeError(error).message);
    } else {
      toast.success("Override added");
      setShowAddDialog(false);
      setNewOverride({ override_type: "feature", key: "", override_value: "true", reason: "", expires_at: "" });
      fetchOverrides();
    }
  };

  const toggleActive = async (id: string, currentActive: boolean) => {
    const { error } = await (supabase.from as any)("org_entitlement_overrides")
      .update({ is_active: !currentActive, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) {
      toast.error(normalizeError(error).message);
    } else {
      fetchOverrides();
    }
  };

  const deleteOverride = async (id: string) => {
    const { error } = await (supabase.from as any)("org_entitlement_overrides")
      .delete()
      .eq("id", id);

    if (error) {
      toast.error(normalizeError(error).message);
    } else {
      toast.success("Override removed");
      fetchOverrides();
    }
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
        <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-1" /> Add Override
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add Entitlement Override</DialogTitle>
              <DialogDescription>
                Grant or revoke a specific feature, app, or limit for this organization.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Override Type</Label>
                <Select value={newOverride.override_type} onValueChange={(v: any) => setNewOverride(p => ({ ...p, override_type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="feature">Feature</SelectItem>
                    <SelectItem value="app">App</SelectItem>
                    <SelectItem value="limit">Limit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Key</Label>
                {newOverride.override_type === "limit" || useCustomKey ? (
                  <div className="space-y-1">
                    <Input
                      placeholder={newOverride.override_type === "feature" ? "e.g., payroll, crm" : newOverride.override_type === "app" ? "e.g., hr, pos" : "e.g., max_users, max_invoices_per_month"}
                      value={newOverride.key}
                      onChange={e => setNewOverride(p => ({ ...p, key: e.target.value }))}
                    />
                    {newOverride.override_type !== "limit" && (
                      <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => { setUseCustomKey(false); setNewOverride(p => ({ ...p, key: "" })); }}>
                        ← Choose from known keys
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Select value={newOverride.key} onValueChange={(v) => setNewOverride(p => ({ ...p, key: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select a key..." /></SelectTrigger>
                      <SelectContent>
                        {newOverride.override_type === "feature" && knownKeys.features.map((f) => (
                          <SelectItem key={f.key} value={f.key}>
                            {f.label} <span className="text-muted-foreground ml-1 text-xs">({f.key})</span>
                          </SelectItem>
                        ))}
                        {newOverride.override_type === "app" && knownKeys.apps.map((appId) => (
                          <SelectItem key={appId} value={appId}>{appId}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setUseCustomKey(true)}>
                      Enter custom key →
                    </Button>
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label>Value</Label>
                {newOverride.override_type === "limit" ? (
                  <Input
                    type="number"
                    placeholder="e.g., 500"
                    value={newOverride.override_value}
                    onChange={e => setNewOverride(p => ({ ...p, override_value: e.target.value }))}
                  />
                ) : (
                  <Select value={newOverride.override_value} onValueChange={(v) => setNewOverride(p => ({ ...p, override_value: v }))}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="true">Grant Access</SelectItem>
                      <SelectItem value="false">Revoke Access</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
              <div className="space-y-2">
                <Label>Reason</Label>
                <Textarea
                  placeholder="Enterprise deal, temporary unlock, grandfathered, etc."
                  value={newOverride.reason}
                  onChange={e => setNewOverride(p => ({ ...p, reason: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Expires At (optional)</Label>
                <Input
                  type="datetime-local"
                  value={newOverride.expires_at}
                  onChange={e => setNewOverride(p => ({ ...p, expires_at: e.target.value }))}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAddDialog(false)}>Cancel</Button>
              <Button onClick={handleAdd}>Add Override</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : overrides.length === 0 ? (
          <p className="text-sm text-muted-foreground">No overrides configured. This organization uses plan defaults only.</p>
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
                <TableHead></TableHead>
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
                    <Button variant="ghost" size="icon" onClick={() => deleteOverride(o.id)}>
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
}

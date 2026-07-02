// @ts-nocheck
import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Layers, Puzzle, Shield } from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";

interface AppUsage {
  app_id: string;
  plan_count: number;
  plans: string[];
}

interface FeatureUsage {
  feature_key: string;
  plan_count: number;
  plans: string[];
}

interface OverrideSummary {
  org_name: string;
  override_count: number;
  types: string[];
}

export function FeatureAdoptionTab() {
  const [appUsage, setAppUsage] = useState<AppUsage[]>([]);
  const [featureUsage, setFeatureUsage] = useState<FeatureUsage[]>([]);
  const [overrides, setOverrides] = useState<OverrideSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [appsRes, featuresRes, plansRes, overridesRes, orgsRes] = await Promise.all([
        supabase.from("plan_app_access").select("plan_id, app_id, is_enabled").eq("is_enabled", true),
        supabase.from("plan_feature_access").select("plan_id, feature_key, is_enabled").eq("is_enabled", true),
        supabase.from("platform_subscription_plans").select("id, name"),
        supabase.from("org_entitlement_overrides").select("organization_id, override_type, key, is_active").eq("is_active", true),
        supabase.from("organizations").select("id, name"),
      ]);

      const planMap = new Map((plansRes.data || []).map(p => [p.id, p.name]));
      const orgMap = new Map((orgsRes.data || []).map(o => [o.id, o.name]));

      // App usage aggregation
      const appMap = new Map<string, Set<string>>();
      (appsRes.data || []).forEach(a => {
        if (!appMap.has(a.app_id)) appMap.set(a.app_id, new Set());
        const planName = planMap.get(a.plan_id) || a.plan_id;
        appMap.get(a.app_id)!.add(planName);
      });
      setAppUsage(Array.from(appMap.entries()).map(([app_id, plans]) => ({
        app_id, plan_count: plans.size, plans: Array.from(plans),
      })).sort((a, b) => b.plan_count - a.plan_count));

      // Feature usage aggregation
      const featMap = new Map<string, Set<string>>();
      (featuresRes.data || []).forEach(f => {
        if (!featMap.has(f.feature_key)) featMap.set(f.feature_key, new Set());
        const planName = planMap.get(f.plan_id) || f.plan_id;
        featMap.get(f.feature_key)!.add(planName);
      });
      setFeatureUsage(Array.from(featMap.entries()).map(([feature_key, plans]) => ({
        feature_key, plan_count: plans.size, plans: Array.from(plans),
      })).sort((a, b) => b.plan_count - a.plan_count));

      // Override aggregation
      const overrideMap = new Map<string, { count: number; types: Set<string> }>();
      (overridesRes.data || []).forEach(o => {
        const orgId = o.organization_id;
        if (!overrideMap.has(orgId)) overrideMap.set(orgId, { count: 0, types: new Set() });
        const entry = overrideMap.get(orgId)!;
        entry.count++;
        entry.types.add(o.override_type);
      });
      setOverrides(Array.from(overrideMap.entries()).map(([orgId, data]) => ({
        org_name: orgMap.get(orgId) || orgId,
        override_count: data.count,
        types: Array.from(data.types),
      })).sort((a, b) => b.override_count - a.override_count));
    } catch (e) {
      console.error("Error fetching feature adoption:", e);
    } finally {
      setIsLoading(false);
    }
  };

  const getExportConfig = (): ExportConfig => ({
    title: "Feature Adoption Report",
    columns: [
      { key: "type", header: "Type" },
      { key: "key", header: "App / Feature" },
      { key: "plan_count", header: "Plans Enabled", format: "number" },
      { key: "plans", header: "Plan Names" },
    ],
    rows: [
      ...appUsage.map(a => ({ type: "App", key: a.app_id, plan_count: a.plan_count, plans: a.plans.join(", ") })),
      ...featureUsage.map(f => ({ type: "Feature", key: f.feature_key, plan_count: f.plan_count, plans: f.plans.join(", ") })),
    ],
    generatedAt: new Date(),
  });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card>
          <CardHeader className="p-4 pb-2"><CardDescription className="text-xs">Apps Configured</CardDescription></CardHeader>
          <CardContent className="p-4 pt-0"><div className="text-2xl font-bold">{appUsage.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="p-4 pb-2"><CardDescription className="text-xs">Premium Features</CardDescription></CardHeader>
          <CardContent className="p-4 pt-0"><div className="text-2xl font-bold">{featureUsage.length}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="p-4 pb-2"><CardDescription className="text-xs">Orgs with Overrides</CardDescription></CardHeader>
          <CardContent className="p-4 pt-0"><div className="text-2xl font-bold text-primary">{overrides.length}</div></CardContent>
        </Card>
      </div>

      {/* App Access Matrix */}
      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2"><Puzzle className="h-4 w-4" /> App Access by Plan</CardTitle>
        </CardHeader>
        <div className="px-4 sm:px-6 pb-2 flex justify-end">
          <ReportExportButtons getExportConfig={getExportConfig} formats={["excel", "csv", "pdf"]} compact />
        </div>
        <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead className="text-center">Plans Enabled</TableHead>
                <TableHead>Plan Names</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {appUsage.map(a => (
                <TableRow key={a.app_id}>
                  <TableCell className="font-medium capitalize">{a.app_id.replace(/_/g, " ")}</TableCell>
                  <TableCell className="text-center"><Badge variant="secondary" className="text-xs">{a.plan_count}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{a.plans.join(", ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Premium Features */}
      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2"><Layers className="h-4 w-4" /> Premium Features by Plan</CardTitle>
        </CardHeader>
        <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                <TableHead className="text-center">Plans Enabled</TableHead>
                <TableHead>Plan Names</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {featureUsage.map(f => (
                <TableRow key={f.feature_key}>
                  <TableCell className="font-medium">{f.feature_key.replace(/_/g, " ")}</TableCell>
                  <TableCell className="text-center"><Badge variant="secondary" className="text-xs">{f.plan_count}</Badge></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{f.plans.join(", ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Override Summary */}
      {overrides.length > 0 && (
        <Card>
          <CardHeader className="p-4 sm:p-6">
            <CardTitle className="text-sm sm:text-base flex items-center gap-2"><Shield className="h-4 w-4" /> Organizations with Overrides</CardTitle>
          </CardHeader>
          <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead className="text-center">Active Overrides</TableHead>
                  <TableHead>Types</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overrides.map(o => (
                  <TableRow key={o.org_name}>
                    <TableCell className="font-medium">{o.org_name}</TableCell>
                    <TableCell className="text-center"><Badge variant="outline" className="text-xs">{o.override_count}</Badge></TableCell>
                    <TableCell>{o.types.map(t => <Badge key={t} variant="secondary" className="text-xs mr-1 capitalize">{t}</Badge>)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

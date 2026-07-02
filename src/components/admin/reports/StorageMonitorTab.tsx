// @ts-nocheck
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HardDrive, Database, FolderOpen, Loader2 } from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";

interface OrgStorageRow {
  id: string;
  name: string;
  plan: string;
  storageMb: number;
  maxStorageMb: number | null;
  percentage: number;
  status: string;
}

interface BucketBreakdown {
  bucket_name: string;
  file_count: number;
  total_bytes: number;
  total_mb: number;
}

function formatStorage(mb: number): string {
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(2)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(2)} MB`;
}

function getStatusColor(pct: number): string {
  if (pct >= 100) return "text-destructive";
  if (pct >= 80) return "text-yellow-600";
  if (pct >= 60) return "text-amber-500";
  return "text-green-600";
}

function getStatusBadge(pct: number, unlimited: boolean) {
  if (unlimited) return <Badge variant="outline" className="text-xs">Unlimited</Badge>;
  if (pct >= 100) return <Badge variant="destructive" className="text-xs">Exceeded</Badge>;
  if (pct >= 80) return <Badge className="text-xs bg-yellow-500/10 text-yellow-700 border-yellow-500/30" variant="outline">Warning</Badge>;
  return <Badge variant="outline" className="text-xs text-green-700">OK</Badge>;
}

export function StorageMonitorTab({ orgUsage }: { orgUsage: OrgStorageRow[] }) {
  const [drilldownOrg, setDrilldownOrg] = useState<OrgStorageRow | null>(null);
  const [breakdown, setBreakdown] = useState<BucketBreakdown[]>([]);
  const [loadingBreakdown, setLoadingBreakdown] = useState(false);

  const totalStorageMb = orgUsage.reduce((s, o) => s + o.storageMb, 0);
  const orgsOverLimit = orgUsage.filter(o => o.percentage >= 100).length;
  const orgsWarning = orgUsage.filter(o => o.percentage >= 80 && o.percentage < 100).length;

  const handleDrilldown = async (org: OrgStorageRow) => {
    setDrilldownOrg(org);
    setLoadingBreakdown(true);
    try {
      const { data } = await (supabase as any).rpc("get_org_storage_breakdown", { p_organization_id: org.id });
      setBreakdown(data || []);
    } catch (e) {
      console.error("Error fetching breakdown:", e);
      setBreakdown([]);
    } finally {
      setLoadingBreakdown(false);
    }
  };

  const getExportConfig = (): ExportConfig => ({
    title: "Storage Usage Report",
    columns: [
      { key: "name", header: "Organization" },
      { key: "plan", header: "Plan" },
      { key: "storage", header: "Storage Used" },
      { key: "limit", header: "Storage Limit" },
      { key: "percentage", header: "% Used", format: "number" },
      { key: "status", header: "Status" },
    ],
    rows: orgUsage.map(o => ({
      name: o.name,
      plan: o.plan,
      storage: formatStorage(o.storageMb),
      limit: o.maxStorageMb ? formatStorage(o.maxStorageMb) : "Unlimited",
      percentage: o.percentage,
      status: o.maxStorageMb == null ? "Unlimited" : o.percentage >= 100 ? "Exceeded" : o.percentage >= 80 ? "Warning" : "OK",
    })),
    generatedAt: new Date(),
  });

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-2 text-xs">
              <HardDrive className="h-3.5 w-3.5" /> Total Platform Storage
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-2xl font-bold">{formatStorage(totalStorageMb)}</div>
            <p className="text-xs text-muted-foreground mt-1">Across {orgUsage.length} organizations</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-2 text-xs">
              <Database className="h-3.5 w-3.5" /> Avg per Org
            </CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className="text-2xl font-bold">{orgUsage.length > 0 ? formatStorage(totalStorageMb / orgUsage.length) : "0 MB"}</div>
          </CardContent>
        </Card>
        <Card className={orgsOverLimit > 0 ? "border-destructive/30 bg-destructive/5" : ""}>
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs">Over Limit</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className={`text-2xl font-bold ${orgsOverLimit > 0 ? "text-destructive" : ""}`}>{orgsOverLimit}</div>
          </CardContent>
        </Card>
        <Card className={orgsWarning > 0 ? "border-yellow-500/30 bg-yellow-500/5" : ""}>
          <CardHeader className="p-4 pb-2">
            <CardDescription className="text-xs">Warning (80%+)</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0">
            <div className={`text-2xl font-bold ${orgsWarning > 0 ? "text-yellow-600" : ""}`}>{orgsWarning}</div>
          </CardContent>
        </Card>
      </div>

      {/* Storage Table */}
      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2">
            <HardDrive className="h-4 w-4" /> Storage by Organization
          </CardTitle>
          <CardDescription className="text-xs sm:text-sm">Click an org to see bucket-level breakdown</CardDescription>
        </CardHeader>
        <div className="px-4 sm:px-6 pb-2 flex justify-end">
          <ReportExportButtons getExportConfig={getExportConfig} formats={["excel", "csv", "pdf"]} compact />
        </div>
        <CardContent className="p-4 pt-0 sm:p-6 sm:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Storage Used</TableHead>
                  <TableHead>Usage</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgUsage.length === 0 ? (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">No organizations found</TableCell></TableRow>
                ) : (
                  orgUsage
                    .sort((a, b) => b.storageMb - a.storageMb)
                    .map(org => (
                      <TableRow key={org.id} className="cursor-pointer hover:bg-muted/50" onClick={() => handleDrilldown(org)}>
                        <TableCell className="font-medium">
                          <div className="flex items-center gap-2">
                            <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                            {org.name}
                          </div>
                        </TableCell>
                        <TableCell><Badge variant="outline" className="text-xs">{org.plan}</Badge></TableCell>
                        <TableCell>
                          <span className={getStatusColor(org.percentage)}>{formatStorage(org.storageMb)}</span>
                          {org.maxStorageMb && <span className="text-muted-foreground text-xs ml-1">/ {formatStorage(org.maxStorageMb)}</span>}
                        </TableCell>
                        <TableCell className="w-[140px]">
                          {org.maxStorageMb ? (
                            <div className="space-y-1">
                              <Progress value={Math.min(org.percentage, 100)} className="h-2" />
                              <span className={`text-xs ${getStatusColor(org.percentage)}`}>{org.percentage.toFixed(1)}%</span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>{getStatusBadge(org.percentage, !org.maxStorageMb)}</TableCell>
                      </TableRow>
                    ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Drilldown Dialog */}
      <Dialog open={!!drilldownOrg} onOpenChange={() => setDrilldownOrg(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HardDrive className="h-5 w-5" />
              Storage Breakdown: {drilldownOrg?.name}
            </DialogTitle>
          </DialogHeader>
          {loadingBreakdown ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : breakdown.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No storage data found for this organization</p>
          ) : (
            <div className="space-y-3">
              <div className="text-sm font-medium text-muted-foreground">
                Total: {formatStorage(breakdown.reduce((s, b) => s + b.total_mb, 0))} across {breakdown.reduce((s, b) => s + b.file_count, 0)} files
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bucket</TableHead>
                    <TableHead className="text-right">Files</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdown.map(b => (
                    <TableRow key={b.bucket_name}>
                      <TableCell className="font-medium">{b.bucket_name}</TableCell>
                      <TableCell className="text-right">{b.file_count}</TableCell>
                      <TableCell className="text-right">{formatStorage(b.total_mb)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

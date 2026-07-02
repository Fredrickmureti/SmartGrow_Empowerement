// @ts-nocheck
import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Activity, UserCheck, UserX, Clock } from "lucide-react";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import type { ExportConfig } from "@/services/reports/ReportExportService";
import { supabase } from "@/integrations/supabase/client";
import { format, differenceInDays } from "date-fns";

interface OrgActivity {
  id: string;
  name: string;
  plan: string;
  status: string;
  last_login: string | null;
  days_inactive: number | null;
  user_count: number;
  created_at: string;
}

export function ActivityTab() {
  const [orgs, setOrgs] = useState<OrgActivity[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [orgsRes, plansRes, rolesRes, loginsRes] = await Promise.all([
        supabase.from("organizations").select("id, name, subscription_plan_id, subscription_status, is_suspended, created_at"),
        supabase.from("platform_subscription_plans").select("id, name"),
        supabase.from("user_roles").select("organization_id, user_id"),
        supabase.from("profiles").select("user_id, last_login_at"),
      ]);

      const planMap = new Map((plansRes.data || []).map(p => [p.id, p.name]));

      // User counts per org
      const userCounts = new Map<string, Set<string>>();
      (rolesRes.data || []).forEach(r => {
        if (!userCounts.has(r.organization_id)) userCounts.set(r.organization_id, new Set());
        userCounts.get(r.organization_id)!.add(r.user_id);
      });

      // Last login per user
      const loginMap = new Map<string, string>();
      (loginsRes.data || []).forEach(p => {
        if (p.last_login_at) loginMap.set(p.user_id, p.last_login_at);
      });

      // Calculate last login per org (most recent across all org users)
      const now = new Date();
      const orgActivities: OrgActivity[] = (orgsRes.data || []).map(org => {
        const orgUsers = userCounts.get(org.id);
        const userIds = orgUsers ? Array.from(orgUsers) : [];
        const logins = userIds.map(uid => loginMap.get(uid)).filter(Boolean) as string[];
        const lastLogin = logins.length > 0 ? logins.sort().reverse()[0] : null;
        const daysInactive = lastLogin ? differenceInDays(now, new Date(lastLogin)) : null;

        return {
          id: org.id,
          name: org.name,
          plan: planMap.get(org.subscription_plan_id) || "No Plan",
          status: org.is_suspended ? "suspended" : org.subscription_status || "none",
          last_login: lastLogin,
          days_inactive: daysInactive,
          user_count: userIds.length,
          created_at: org.created_at,
        };
      });

      setOrgs(orgActivities.sort((a, b) => (b.days_inactive ?? 999) - (a.days_inactive ?? 999)));
    } catch (e) {
      console.error("Error fetching activity:", e);
    } finally {
      setIsLoading(false);
    }
  };

  const activeOrgs = orgs.filter(o => o.days_inactive !== null && o.days_inactive <= 7).length;
  const dormantOrgs = orgs.filter(o => o.days_inactive === null || o.days_inactive > 30).length;
  const recentOrgs = orgs.filter(o => o.days_inactive !== null && o.days_inactive > 7 && o.days_inactive <= 30).length;

  const getActivityBadge = (days: number | null) => {
    if (days === null) return <Badge variant="outline" className="text-xs">Never</Badge>;
    if (days <= 1) return <Badge className="text-xs bg-green-500/10 text-green-700 border-green-500/30" variant="outline">Active today</Badge>;
    if (days <= 7) return <Badge className="text-xs bg-green-500/10 text-green-700 border-green-500/30" variant="outline">This week</Badge>;
    if (days <= 30) return <Badge className="text-xs bg-yellow-500/10 text-yellow-700 border-yellow-500/30" variant="outline">{days}d ago</Badge>;
    return <Badge variant="destructive" className="text-xs">{days}d dormant</Badge>;
  };

  const getExportConfig = (): ExportConfig => ({
    title: "Organization Activity Report",
    columns: [
      { key: "name", header: "Organization" },
      { key: "plan", header: "Plan" },
      { key: "status", header: "Status" },
      { key: "user_count", header: "Users", format: "number" },
      { key: "last_login", header: "Last Login" },
      { key: "days_inactive", header: "Days Inactive", format: "number" },
      { key: "created_at", header: "Created" },
    ],
    rows: orgs.map(o => ({
      name: o.name,
      plan: o.plan,
      status: o.status,
      user_count: o.user_count,
      last_login: o.last_login ? format(new Date(o.last_login), "yyyy-MM-dd HH:mm") : "Never",
      days_inactive: o.days_inactive ?? "N/A",
      created_at: format(new Date(o.created_at), "yyyy-MM-dd"),
    })),
    generatedAt: new Date(),
  });

  return (
    <div className="space-y-6">
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-3">
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-2 text-xs"><UserCheck className="h-3.5 w-3.5 text-green-600" /> Active (7 days)</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0"><div className="text-2xl font-bold text-green-600">{activeOrgs}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-2 text-xs"><Clock className="h-3.5 w-3.5 text-yellow-600" /> Slowing Down</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0"><div className="text-2xl font-bold text-yellow-600">{recentOrgs}</div></CardContent>
        </Card>
        <Card className={dormantOrgs > 0 ? "border-destructive/30 bg-destructive/5" : ""}>
          <CardHeader className="p-4 pb-2">
            <CardDescription className="flex items-center gap-2 text-xs"><UserX className="h-3.5 w-3.5" /> Dormant (30d+)</CardDescription>
          </CardHeader>
          <CardContent className="p-4 pt-0"><div className={`text-2xl font-bold ${dormantOrgs > 0 ? "text-destructive" : ""}`}>{dormantOrgs}</div></CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-sm sm:text-base flex items-center gap-2"><Activity className="h-4 w-4" /> Organization Activity</CardTitle>
          <CardDescription className="text-xs sm:text-sm">Sorted by most inactive first</CardDescription>
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
                  <TableHead className="text-center">Users</TableHead>
                  <TableHead>Last Login</TableHead>
                  <TableHead>Activity</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orgs.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No organizations found</TableCell></TableRow>
                ) : (
                  orgs.map(o => (
                    <TableRow key={o.id}>
                      <TableCell className="font-medium">{o.name}</TableCell>
                      <TableCell><Badge variant="outline" className="text-xs">{o.plan}</Badge></TableCell>
                      <TableCell className="text-center">{o.user_count}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {o.last_login ? format(new Date(o.last_login), "MMM d, yyyy") : "Never"}
                      </TableCell>
                      <TableCell>{getActivityBadge(o.days_inactive)}</TableCell>
                      <TableCell>
                        <Badge variant={o.status === "active" ? "default" : o.status === "trialing" ? "secondary" : "destructive"} className="text-xs">
                          {o.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

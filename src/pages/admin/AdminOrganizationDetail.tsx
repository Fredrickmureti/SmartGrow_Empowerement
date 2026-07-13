// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { fetchOwnerEmails } from "@/hooks/useOwnerEmails";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
// ManageSubscriptionDialog retired — this page now navigates to the
// /admin-management/organizations/:id/subscription workspace.
import { SuspendOrganizationDialog } from "@/components/admin/SuspendOrganizationDialog";
import { OrgEntitlementOverrides } from "@/components/admin/OrgEntitlementOverrides";
import { CommercialTimeline } from "@/components/admin/CommercialTimeline";
import { DeletionJobsPanel } from "@/components/admin/DeletionJobsPanel";
import { format, differenceInDays } from "date-fns";
import {
  ArrowLeft,
  Building2,
  Users,
  FileText,
  DollarSign,
  CreditCard,
  Calendar,
  Mail,
  Globe,
  Loader2,
  PauseCircle,
  PlayCircle,
  Shield,
  BarChart3,
  Clock,
  CheckCircle,
  AlertTriangle,
  XCircle,
  Briefcase,
  MapPin,
  Activity,
  ChevronRight,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface OrgDetail {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  base_currency: string | null;
  created_at: string;
  subscription_plan_id: string | null;
  subscription_status: string | null;
  subscription_started_at: string | null;
  subscription_ends_at: string | null;
  trial_ends_at: string | null;
  is_suspended: boolean;
  suspended_reason: string | null;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  trial: { label: "Trial", color: "bg-blue-500/10 text-blue-600 border-blue-200", icon: Clock },
  active: { label: "Active", color: "bg-green-500/10 text-green-600 border-green-200", icon: CheckCircle },
  expired: { label: "Expired", color: "bg-orange-500/10 text-orange-600 border-orange-200", icon: XCircle },
  cancelled: { label: "Cancelled", color: "bg-muted text-muted-foreground border-border", icon: XCircle },
  past_due: { label: "Past Due", color: "bg-yellow-500/10 text-yellow-600 border-yellow-200", icon: AlertTriangle },
  suspended: { label: "Suspended", color: "bg-red-500/10 text-red-600 border-red-200", icon: AlertTriangle },
  none: { label: "No Plan", color: "bg-muted text-muted-foreground border-border", icon: XCircle },
};

export default function AdminOrganizationDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { formatCurrency } = useAdminCurrency();

  const [org, setOrg] = useState<OrgDetail | null>(null);
  const [plan, setPlan] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [businesses, setBusinesses] = useState<any[]>([]);
  const [usageCounters, setUsageCounters] = useState<any>(null);
  const [recentInvoices, setRecentInvoices] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  
  const [suspendDialogOpen, setSuspendDialogOpen] = useState(false);
  const [expandedBusinesses, setExpandedBusinesses] = useState<Set<string>>(new Set());

  const fetchAll = async () => {
    if (!id) return;
    setIsLoading(true);
    try {
      // Fetch org
      const { data: orgData, error: orgErr } = await (supabase.from as any)("organizations")
        .select("*")
        .eq("id", id)
        .single();
      if (orgErr) throw orgErr;
      setOrg(orgData);

      // Fetch plan name
      if (orgData.subscription_plan_id) {
        const { data: planData } = await (supabase.from as any)("platform_subscription_plans")
          .select("*")
          .eq("id", orgData.subscription_plan_id)
          .single();
        setPlan(planData);
      }

      // Fetch usage counters via RPC. NULL-safe: skip when id is undefined
      // and tolerate failure — counters are advisory and must never block
      // the delete UI.
      if (id) {
        try {
          const { data: counters } = await supabase.rpc(
            "get_org_usage_counters",
            { _org_id: id } as any,
          );
          setUsageCounters(counters);
        } catch (err) {
          console.warn("[AdminOrganizationDetail] usage counters unavailable:", err);
          setUsageCounters(null);
        }
      }

      // Fetch members
      const { data: rolesData } = await (supabase.from as any)("user_roles")
        .select("id, user_id, role, is_active, created_at")
        .eq("organization_id", id)
        .eq("is_active", true);
      
      const userIds = (rolesData || []).map((r: any) => r.user_id);
      let profilesMap = new Map();
      if (userIds.length > 0) {
        const { data: profilesData } = await (supabase.from as any)("profiles")
          .select("user_id, email, full_name, avatar_url")
          .in("user_id", userIds);
        profilesMap = new Map((profilesData || []).map((p: any) => [p.user_id, p]));
      }
      setMembers((rolesData || []).map((r: any) => ({
        ...r,
        email: profilesMap.get(r.user_id)?.email || "Unknown",
        full_name: profilesMap.get(r.user_id)?.full_name || null,
        avatar_url: profilesMap.get(r.user_id)?.avatar_url || null,
      })));

      // Fetch businesses + branches
      const { data: bizData } = await (supabase.from as any)("businesses")
        .select("*").eq("organization_id", id).eq("is_active", true).order("name");
      const bizIds = (bizData || []).map((b: any) => b.id);
      let branchesData: any[] = [];
      if (bizIds.length > 0) {
        const { data } = await (supabase.from as any)("branches")
          .select("*").in("business_id", bizIds).eq("is_active", true);
        branchesData = data || [];
      }
      const withBranches = (bizData || []).map((b: any) => ({
        ...b,
        branches: branchesData.filter((br: any) => br.business_id === b.id),
      }));
      setBusinesses(withBranches);
      setExpandedBusinesses(new Set(withBranches.map((b: any) => b.id)));

      // Recent invoices
      const { data: invData } = await (supabase.from as any)("invoices")
        .select("id, invoice_number, total, status, created_at")
        .eq("organization_id", id)
        .order("created_at", { ascending: false })
        .limit(10);
      setRecentInvoices(invData || []);

      // Payments
      const { data: payData } = await (supabase.from as any)("subscription_payments")
        .select("*")
        .eq("organization_id", id)
        .order("created_at", { ascending: false })
        .limit(10);
      setPayments(payData || []);

      // Audit logs for this org
      const { data: logData } = await (supabase.from as any)("admin_audit_log")
        .select("*")
        .eq("target_org_id", id)
        .order("created_at", { ascending: false })
        .limit(20);
      setAuditLogs(logData || []);

    } catch (error: any) {
      console.error("Error:", error);
      toast({ title: "Error", description: "Failed to load organization details", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, [id]);

  if (isLoading) {
    return (
      <>
        <div className="flex items-center justify-center h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </>
    );
  }

  if (!org) {
    return (
      <>
        <div className="p-8 text-center">
          <p className="text-muted-foreground">Organization not found</p>
          <Button variant="outline" className="mt-4" onClick={() => navigate("/admin-management/organizations")}>
            <ArrowLeft className="h-4 w-4 mr-2" /> Back to Organizations
          </Button>
        </div>
      </>
    );
  }

  const now = new Date();
  const getStatus = () => {
    if (org.is_suspended) return "suspended";
    const s = org.subscription_status || "none";
    if (s === "trial" && org.trial_ends_at && new Date(org.trial_ends_at) < now) return "expired";
    if (s === "active" && org.subscription_ends_at && new Date(org.subscription_ends_at) < now) return "expired";
    return s;
  };
  const effectiveStatus = getStatus();
  const statusCfg = STATUS_CONFIG[effectiveStatus] || STATUS_CONFIG.none;
  const StatusIcon = statusCfg.icon;

  const daysRemaining = (() => {
    if (effectiveStatus === "trial" && org.trial_ends_at) return differenceInDays(new Date(org.trial_ends_at), now);
    if (org.subscription_ends_at) return differenceInDays(new Date(org.subscription_ends_at), now);
    return null;
  })();

  const maxUsers = plan?.max_users;
  const maxInvoices = plan?.max_invoices_per_month;
  const currentUsers = usageCounters?.users_count || 0;
  const currentInvoices = usageCounters?.invoices_this_month || 0;
  const currentEmployees = usageCounters?.employees_count || 0;

  const roleLabels: Record<string, string> = {
    super_admin: "Super Admin", owner: "Owner", admin: "Admin",
    accountant: "Accountant", staff: "Staff", cashier: "Cashier", viewer: "Viewer",
  };

  const toggleBusiness = (bid: string) => {
    const next = new Set(expandedBusinesses);
    next.has(bid) ? next.delete(bid) : next.add(bid);
    setExpandedBusinesses(next);
  };

  const UsageMeter = ({ label, current, limit, icon: Icon }: { label: string; current: number; limit: number | null; icon: any }) => {
    const pct = limit ? Math.min(100, (current / limit) * 100) : 0;
    const isNearLimit = limit ? pct >= 80 : false;
    const isAtLimit = limit ? pct >= 100 : false;
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Icon className="h-4 w-4 text-muted-foreground" />
            {label}
          </div>
          <span className={cn("text-sm font-mono", isAtLimit && "text-destructive", isNearLimit && !isAtLimit && "text-yellow-600")}>
            {current} / {limit ?? "∞"}
          </span>
        </div>
        {limit && (
          <Progress
            value={pct}
            className={cn("h-2", isAtLimit && "[&>div]:bg-destructive", isNearLimit && !isAtLimit && "[&>div]:bg-yellow-500")}
          />
        )}
      </div>
    );
  };

  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" size="icon" className="flex-shrink-0" onClick={() => navigate("/admin-management/organizations")}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="h-10 w-10 sm:h-12 sm:w-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center overflow-hidden border flex-shrink-0">
              <Building2 className="h-5 w-5 sm:h-6 sm:w-6 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg sm:text-2xl font-bold tracking-tight truncate">{org.name}</h1>
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                <Badge variant="outline" className="font-mono text-[10px] sm:text-xs">{org.slug}</Badge>
                <Badge className={cn("text-[10px] sm:text-xs", statusCfg.color)}>
                  <StatusIcon className="h-3 w-3 mr-1" />
                  {statusCfg.label}
                </Badge>
                {daysRemaining !== null && daysRemaining > 0 && daysRemaining <= 14 && (
                  <Badge variant="outline" className="text-[10px] sm:text-xs text-yellow-600 border-yellow-300">
                    {daysRemaining}d remaining
                  </Badge>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 pl-12 sm:pl-0 flex-shrink-0">
            <Button variant="outline" size="sm" className="text-xs sm:text-sm" onClick={() => navigate(`/admin-management/organizations/${id}/subscription`)}>
              <CreditCard className="h-4 w-4 mr-1.5" />
              <span className="hidden sm:inline">Manage</span> Plan
            </Button>
            <Button
              variant={org.is_suspended ? "default" : "destructive"}
              size="sm"
              className="text-xs sm:text-sm"
              onClick={() => setSuspendDialogOpen(true)}
            >
              {org.is_suspended ? <PlayCircle className="h-4 w-4 mr-1.5" /> : <PauseCircle className="h-4 w-4 mr-1.5" />}
              {org.is_suspended ? "Unsuspend" : "Suspend"}
            </Button>
          </div>
        </div>

        {/* Quick Stats Row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3">
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Users className="h-4 w-4 text-blue-500" />
              </div>
              <div>
                <p className="text-lg font-bold">{currentUsers}</p>
                <p className="text-[11px] text-muted-foreground">Users</p>
              </div>
            </div>
          </Card>
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
                <Briefcase className="h-4 w-4 text-purple-500" />
              </div>
              <div>
                <p className="text-lg font-bold">{businesses.length}</p>
                <p className="text-[11px] text-muted-foreground">Businesses</p>
              </div>
            </div>
          </Card>
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <FileText className="h-4 w-4 text-amber-500" />
              </div>
              <div>
                <p className="text-lg font-bold">{currentInvoices}</p>
                <p className="text-[11px] text-muted-foreground">Invoices/mo</p>
              </div>
            </div>
          </Card>
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <Users className="h-4 w-4 text-emerald-500" />
              </div>
              <div>
                <p className="text-lg font-bold">{currentEmployees}</p>
                <p className="text-[11px] text-muted-foreground">Employees</p>
              </div>
            </div>
          </Card>
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                <CreditCard className="h-4 w-4 text-cyan-500" />
              </div>
              <div>
                <p className="text-lg font-bold truncate">{plan?.name || "None"}</p>
                <p className="text-[11px] text-muted-foreground">Plan</p>
              </div>
            </div>
          </Card>
          <Card className="p-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-pink-500/10 flex items-center justify-center">
                <Calendar className="h-4 w-4 text-pink-500" />
              </div>
              <div>
                <p className="text-sm font-bold">{format(new Date(org.created_at), "MMM yyyy")}</p>
                <p className="text-[11px] text-muted-foreground">Created</p>
              </div>
            </div>
          </Card>
        </div>

        {/* Main Tabs */}
        <Tabs defaultValue="overview" className="space-y-4">
          <div className="overflow-x-auto scrollbar-hide -mx-3 px-3 sm:-mx-0 sm:px-0">
            <TabsList className="inline-flex w-max gap-0.5 h-auto p-0.5 sm:p-1">
              <TabsTrigger value="overview" className="text-xs sm:text-sm px-3 py-1.5">Overview</TabsTrigger>
              <TabsTrigger value="subscription" className="text-xs sm:text-sm px-3 py-1.5">Subscription</TabsTrigger>
              <TabsTrigger value="overrides" className="text-xs sm:text-sm px-3 py-1.5">Overrides</TabsTrigger>
              <TabsTrigger value="members" className="text-xs sm:text-sm px-3 py-1.5">Members</TabsTrigger>
              <TabsTrigger value="usage" className="text-xs sm:text-sm px-3 py-1.5">Usage</TabsTrigger>
              <TabsTrigger value="activity" className="text-xs sm:text-sm px-3 py-1.5">Activity</TabsTrigger>
              <TabsTrigger value="timeline" className="text-xs sm:text-sm px-3 py-1.5">Timeline</TabsTrigger>
              <TabsTrigger value="deletion" className="text-xs sm:text-sm px-3 py-1.5">Deletion</TabsTrigger>
            </TabsList>
          </div>

          {/* OVERVIEW TAB */}
          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Org Info */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Organization Info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-3 text-sm">
                    <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span>{org.email || members.find((m: any) => m.role === "owner")?.email || "No email"}</span>
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Globe className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span>Currency: {org.base_currency || "USD"}</span> // architecture-allow: display-only fallback
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                    <span>Created: {format(new Date(org.created_at), "MMMM d, yyyy")}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Usage Summary */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Usage Summary</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <UsageMeter label="Users" current={currentUsers} limit={maxUsers} icon={Users} />
                  <UsageMeter label="Invoices / Month" current={currentInvoices} limit={maxInvoices} icon={FileText} />
                  <UsageMeter label="Employees" current={currentEmployees} limit={null} icon={Users} />
                </CardContent>
              </Card>

              {/* Business Structure */}
              <Card className="lg:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">Business Structure</CardTitle>
                  <CardDescription>{businesses.length} business(es), {businesses.reduce((s: number, b: any) => s + (b.branches?.length || 0), 0)} branch(es)</CardDescription>
                </CardHeader>
                <CardContent>
                  {businesses.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-6">No businesses created yet</p>
                  ) : (
                    <div className="space-y-2">
                      {businesses.map((biz: any) => (
                        <Collapsible key={biz.id} open={expandedBusinesses.has(biz.id)} onOpenChange={() => toggleBusiness(biz.id)}>
                          <CollapsibleTrigger className="w-full">
                            <div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
                              <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", expandedBusinesses.has(biz.id) && "rotate-90")} />
                              <Briefcase className="h-4 w-4 text-blue-500" />
                              <span className="font-medium text-sm">{biz.name}</span>
                              <span className="text-xs text-muted-foreground ml-auto">{biz.branches?.length || 0} branches</span>
                            </div>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="ml-8 mt-1 space-y-1 border-l-2 border-muted pl-4">
                              {(biz.branches || []).map((br: any) => (
                                <div key={br.id} className="flex items-center gap-2 p-2 rounded bg-muted/30 text-sm">
                                  <MapPin className="h-3 w-3 text-amber-500" />
                                  <span>{br.name}</span>
                                  {br.is_headquarters && <Badge variant="outline" className="text-[10px] px-1.5 py-0">HQ</Badge>}
                                </div>
                              ))}
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* SUBSCRIPTION TAB */}
          <TabsContent value="subscription" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <CreditCard className="h-4 w-4" /> Current Plan
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Plan</span>
                    <span className="font-medium">{plan?.name || "No plan assigned"}</span>
                  </div>
                  {plan && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Monthly</span>
                        <span className="font-medium">{formatCurrency(plan.price_monthly)}</span>
                      </div>
                      {plan.price_yearly && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">Yearly</span>
                          <span className="font-medium">{formatCurrency(plan.price_yearly)}</span>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">Max Users</span>
                        <span className="font-medium">{plan.max_users ?? "Unlimited"}</span>
                      </div>
                    </>
                  )}
                  <Separator />
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Status</span>
                    <Badge className={cn("text-xs", statusCfg.color)}>{statusCfg.label}</Badge>
                  </div>
                  {org.subscription_ends_at && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Ends</span>
                      <span className="font-medium">{format(new Date(org.subscription_ends_at), "MMM d, yyyy")}</span>
                    </div>
                  )}
                  <Button className="w-full mt-2" variant="outline" onClick={() => navigate(`/admin-management/organizations/${id}/subscription`)}>
                    Change Plan
                  </Button>
                </CardContent>
              </Card>

              {/* Payment History */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm flex items-center gap-2">
                    <DollarSign className="h-4 w-4" /> Payment History
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {payments.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-6">No payments recorded</p>
                  ) : (
                    <div className="space-y-2">
                      {payments.map((p: any) => (
                        <div key={p.id} className="flex items-center justify-between p-2 rounded border text-sm">
                          <div>
                            <p className="font-medium">{formatCurrency(p.amount)}</p>
                            <p className="text-xs text-muted-foreground">{format(new Date(p.created_at), "MMM d, yyyy")}</p>
                          </div>
                          <Badge variant={p.status === "completed" ? "default" : "secondary"}>{p.status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* OVERRIDES TAB */}
          <TabsContent value="overrides">
            <OrgEntitlementOverrides organizationId={org.id} organizationName={org.name} />
          </TabsContent>

          {/* COMMERCIAL TIMELINE TAB */}
          <TabsContent value="timeline">
            <CommercialTimeline organizationId={org.id} />
          </TabsContent>

          <TabsContent value="deletion">
            <DeletionJobsPanel organizationId={org.id} />
          </TabsContent>

          {/* MEMBERS TAB */}
          <TabsContent value="members">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Members ({members.length}{maxUsers ? ` / ${maxUsers}` : ""})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto -mx-6 px-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Role</TableHead>
                      <TableHead>Joined</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {members.map((m: any) => (
                      <TableRow key={m.id}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{m.full_name || m.email}</p>
                            {m.full_name && <p className="text-xs text-muted-foreground">{m.email}</p>}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{roleLabels[m.role] || m.role}</Badge>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {format(new Date(m.created_at), "MMM d, yyyy")}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* USAGE TAB */}
          <TabsContent value="usage" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <BarChart3 className="h-4 w-4" /> Usage Meters
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                <UsageMeter label="Active Users" current={currentUsers} limit={maxUsers} icon={Users} />
                <UsageMeter label="Invoices This Month" current={currentInvoices} limit={maxInvoices} icon={FileText} />
                <UsageMeter label="Active Employees" current={currentEmployees} limit={null} icon={Users} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Recent Invoices</CardTitle>
              </CardHeader>
              <CardContent>
                {recentInvoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">No invoices</p>
                ) : (
                  <div className="overflow-x-auto -mx-6 px-6">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Invoice #</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentInvoices.map((inv: any) => (
                        <TableRow key={inv.id}>
                          <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                          <TableCell>{formatCurrency(inv.total)}</TableCell>
                          <TableCell><Badge variant={inv.status === "paid" ? "default" : "secondary"}>{inv.status}</Badge></TableCell>
                          <TableCell className="text-sm text-muted-foreground">{format(new Date(inv.created_at), "MMM d, yyyy")}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ACTIVITY TAB */}
          <TabsContent value="activity">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Activity className="h-4 w-4" /> Admin Activity Log
                </CardTitle>
              </CardHeader>
              <CardContent>
                {auditLogs.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">No activity recorded yet</p>
                ) : (
                  <div className="space-y-2">
                    {auditLogs.map((log: any) => (
                      <div key={log.id} className="flex items-start gap-3 p-3 rounded border text-sm">
                        <Activity className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <p className="font-medium">{log.action_type}</p>
                          {log.details && Object.keys(log.details).length > 0 && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {JSON.stringify(log.details).slice(0, 120)}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(log.created_at), "MMM d, HH:mm")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialogs */}

      <SuspendOrganizationDialog
        open={suspendDialogOpen}
        onOpenChange={setSuspendDialogOpen}
        organization={org}
        onSuccess={fetchAll}
      />
    </>
  );
}

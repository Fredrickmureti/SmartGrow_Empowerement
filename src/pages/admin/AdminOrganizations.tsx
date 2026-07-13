import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { fetchOwnerEmails } from "@/hooks/useOwnerEmails";
import { supabase } from "@/integrations/supabase/client";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";
import { useCountries } from "@/hooks/useCountries";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Building2, Users, FileText, Search, MoreHorizontal, Eye, Loader2, RefreshCw,
  DollarSign, Trash2, PauseCircle, CreditCard, PlayCircle, AlertTriangle,
  Clock, CheckCircle, XCircle, Filter, Globe, CalendarClock,
} from "lucide-react";
import { format, differenceInDays } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
// MultiStepDeleteDialog retired — Delete Organization is now the wizard route
// /admin-management/organizations/:id/delete (see docs/design-system/audit/platform-admin.md).
// OrganizationDetailsDialog removed — the "View details" action navigates to
// the /admin-management/organizations/:id workspace page (see
// docs/design-system/audit/platform-admin.md).
// ManageSubscriptionDialog retired — Manage Subscription now routes to the
// /admin-management/organizations/:id/subscription workspace page.
import { SuspendOrganizationDialog } from "@/components/admin/SuspendOrganizationDialog";
import { ScheduleDeletionDialog } from "@/components/admin/ScheduleDeletionDialog";
import { normalizeError } from "@/services/resilience";

interface OrganizationWithStats {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  ownerEmail: string | null;
  resolvedEmail: string | null;
  base_currency: string | null;
  created_at: string;
  memberCount: number;
  invoiceCount: number;
  totalRevenue: number;
  subscription_plan_id?: string | null;
  subscription_status?: string | null;
  subscription_started_at?: string | null;
  subscription_ends_at?: string | null;
  trial_ends_at?: string | null;
  is_suspended?: boolean;
  suspended_reason?: string | null;
  scheduled_deletion_at?: string | null;
  deletion_grace_days?: number | null;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  trial: { label: "Trial", color: "bg-blue-500/10 text-blue-600 border-blue-200", icon: Clock },
  active: { label: "Active", color: "bg-green-500/10 text-green-600 border-green-200", icon: CheckCircle },
  expired: { label: "Expired", color: "bg-orange-500/10 text-orange-600 border-orange-200", icon: XCircle },
  cancelled: { label: "Cancelled", color: "bg-gray-500/10 text-gray-600 border-gray-200", icon: XCircle },
  past_due: { label: "Past Due", color: "bg-yellow-500/10 text-yellow-600 border-yellow-200", icon: AlertTriangle },
  suspended: { label: "Suspended", color: "bg-red-500/10 text-red-600 border-red-200", icon: AlertTriangle },
};

export default function AdminOrganizations() {
  const navigate = useNavigate();
  const [organizations, setOrganizations] = useState<OrganizationWithStats[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [suspendDialogOpen, setSuspendDialogOpen] = useState(false);
  const [scheduleDeleteDialogOpen, setScheduleDeleteDialogOpen] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState<OrganizationWithStats | null>(null);
  const { toast } = useToast();
  const { formatCurrency } = useAdminCurrency();
  const { countryScopes, isGlobalAccess, hasCountryScope } = usePlatformPermissions();
  const { countries } = useCountries();

  const fetchOrganizations = async () => {
    setIsLoading(true);
    try {
      // Fetch all organizations with their stats
      const { data: orgs, error: orgsError } = await supabase
        .from("organizations")
        .select("*")
        .order("created_at", { ascending: false });

      if (orgsError) throw orgsError;

      // Fetch member counts
      const { data: roleCounts } = await supabase
        .from("user_roles")
        .select("organization_id")
        .eq("is_active", true);

      // Fetch invoice counts and revenue
      const { data: invoiceStats } = await supabase
        .from("invoices")
        .select("organization_id, total");

      // Fetch owner emails
      const orgIds = (orgs || []).map(o => o.id);
      const ownerEmailsMap = await fetchOwnerEmails(orgIds);

      // Identity (email, base_currency, ...) now lives on `businesses`.
      // Load each org's primary active business to enrich the admin list.
      const { data: bizRows } = await supabase
        .from("businesses")
        .select("organization_id, email, base_currency, created_at")
        .in("organization_id", orgIds.length ? orgIds : ["00000000-0000-0000-0000-000000000000"])
        .eq("is_active", true)
        .order("created_at", { ascending: true });
      const primaryBizByOrg = new Map<string, { email: string | null; base_currency: string | null }>();
      for (const b of bizRows || []) {
        if (!primaryBizByOrg.has(b.organization_id)) {
          primaryBizByOrg.set(b.organization_id, { email: b.email, base_currency: b.base_currency });
        }
      }

      // Combine data
      const orgsWithStats: OrganizationWithStats[] = (orgs || []).map((org) => {
        const memberCount = roleCounts?.filter((r) => r.organization_id === org.id).length || 0;
        const orgInvoices = invoiceStats?.filter((i) => i.organization_id === org.id) || [];
        const invoiceCount = orgInvoices.length;
        const totalRevenue = orgInvoices.reduce((sum, inv) => sum + Number(inv.total || 0), 0);
        const ownerEmail = ownerEmailsMap[org.id] || null;
        const biz = primaryBizByOrg.get(org.id);
        const orgEmail = biz?.email ?? null;

        return {
          ...(org as any),
          email: orgEmail,
          base_currency: biz?.base_currency ?? null,
          memberCount,
          invoiceCount,
          totalRevenue,
          ownerEmail,
          resolvedEmail: orgEmail || ownerEmail,
        };
      });

      setOrganizations(orgsWithStats);
    } catch (error) {
      console.error("Error fetching organizations:", error);
      toast({
        title: "Error",
        description: "Failed to load organizations",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchOrganizations();
  }, []);

  const handleViewDetails = (org: OrganizationWithStats) => {
    navigate(`/admin-management/organizations/${org.id}`);
  };

  const handleManageSubscription = (org: OrganizationWithStats) => {
    navigate(`/admin-management/organizations/${org.id}/subscription`);
  };

  const handleOpenDelete = (org: OrganizationWithStats) => {
    navigate(`/admin-management/organizations/${org.id}/delete`);
  };

  const handleSuspendOrg = (org: OrganizationWithStats) => {
    setSelectedOrg(org);
    setSuspendDialogOpen(true);
  };

  const handleScheduleDeletion = (org: OrganizationWithStats) => {
    setSelectedOrg(org);
    setScheduleDeleteDialogOpen(true);
  };

  // Get subscription status for an organization
  const getSubscriptionInfo = (org: OrganizationWithStats) => {
    const now = new Date();
    
    if (org.is_suspended) {
      return { 
        status: 'suspended', 
        daysRemaining: null,
        isExpiringSoon: false 
      };
    }

    const status = org.subscription_status || 'none';
    let endDate: Date | null = null;
    
    if (status === 'trial' && org.trial_ends_at) {
      endDate = new Date(org.trial_ends_at);
    } else if (org.subscription_ends_at) {
      endDate = new Date(org.subscription_ends_at);
    }

    const daysRemaining = endDate ? differenceInDays(endDate, now) : null;
    const isExpiringSoon = daysRemaining !== null && daysRemaining <= 7 && daysRemaining > 0;
    const isExpired = daysRemaining !== null && daysRemaining <= 0;

    return {
      status: isExpired ? 'expired' : status,
      daysRemaining,
      isExpiringSoon,
    };
  };

  // Filter organizations by country scope + UI filters
  const scopedOrgs = organizations.filter(org => {
    // Apply country scope restriction
    if (!isGlobalAccess) {
      const orgCountry = (org as any).country || (org as any).base_currency;
      // If org has no country info, only global admins see it
      if (!orgCountry) return false;
      if (!hasCountryScope(orgCountry)) return false;
    }
    // Apply country filter
    if (countryFilter !== "all") {
      const orgCountry = (org as any).country || "";
      if (orgCountry !== countryFilter) return false;
    }
    return true;
  });

  const filteredOrgs = scopedOrgs.filter((org) => {
    const matchesSearch = 
      org.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      org.slug.toLowerCase().includes(searchQuery.toLowerCase()) ||
      org.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      org.resolvedEmail?.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    if (statusFilter === "all") return true;
    if (statusFilter === "expiring_soon") {
      const info = getSubscriptionInfo(org);
      return info.isExpiringSoon;
    }
    if (statusFilter === "suspended") {
      return org.is_suspended;
    }

    const info = getSubscriptionInfo(org);
    return info.status === statusFilter;
  });

  // Count by status
  const statusCounts = {
    all: scopedOrgs.length,
    trial: scopedOrgs.filter(o => !o.is_suspended && o.subscription_status === 'trial').length,
    active: scopedOrgs.filter(o => !o.is_suspended && o.subscription_status === 'active').length,
    expired: scopedOrgs.filter(o => {
      const info = getSubscriptionInfo(o);
      return info.status === 'expired';
    }).length,
    suspended: scopedOrgs.filter(o => o.is_suspended).length,
    expiring_soon: scopedOrgs.filter(o => getSubscriptionInfo(o).isExpiringSoon).length,
  };


  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight">Organizations</h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Manage all organizations on the platform
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={fetchOrganizations} disabled={isLoading} className="w-full sm:w-auto text-xs sm:text-sm">
            <RefreshCw className={`mr-2 h-3.5 w-3.5 sm:h-4 sm:w-4 ${isLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-4">
          <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => setStatusFilter("all")}>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1.5 text-[11px] sm:text-sm">
                <Building2 className="h-3 w-3 sm:h-4 sm:w-4" />
                Total
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 sm:p-4 pt-0">
              <div className="text-xl sm:text-2xl font-bold">{statusCounts.all}</div>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => setStatusFilter("trial")}>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1.5 text-blue-600 text-[11px] sm:text-sm">
                <Clock className="h-3 w-3 sm:h-4 sm:w-4" />
                On Trial
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 sm:p-4 pt-0">
              <div className="text-xl sm:text-2xl font-bold text-blue-600">{statusCounts.trial}</div>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => setStatusFilter("active")}>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1.5 text-green-600 text-[11px] sm:text-sm">
                <CheckCircle className="h-3 w-3 sm:h-4 sm:w-4" />
                Active
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 sm:p-4 pt-0">
              <div className="text-xl sm:text-2xl font-bold text-green-600">{statusCounts.active}</div>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => setStatusFilter("expiring_soon")}>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1.5 text-yellow-600 text-[11px] sm:text-sm">
                <AlertTriangle className="h-3 w-3 sm:h-4 sm:w-4" />
                Expiring Soon
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 sm:p-4 pt-0">
              <div className="text-xl sm:text-2xl font-bold text-yellow-600">{statusCounts.expiring_soon}</div>
            </CardContent>
          </Card>
          <Card className="cursor-pointer hover:border-primary/50 transition-colors col-span-2 sm:col-span-1" onClick={() => setStatusFilter("suspended")}>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1.5 text-red-600 text-[11px] sm:text-sm">
                <AlertTriangle className="h-3 w-3 sm:h-4 sm:w-4" />
                Suspended
              </CardDescription>
            </CardHeader>
            <CardContent className="p-3 sm:p-4 pt-0">
              <div className="text-xl sm:text-2xl font-bold text-red-600">{statusCounts.suspended}</div>
            </CardContent>
          </Card>
        </div>

        {/* Search & Table */}
        <Card>
          <CardHeader className="p-3 sm:p-6">
            <div className="flex flex-col gap-3">
              <CardTitle className="text-sm sm:text-base">All Organizations</CardTitle>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-full sm:w-40 text-xs sm:text-sm h-8 sm:h-9">
                    <Filter className="h-3 w-3 sm:h-4 sm:w-4 mr-1.5" />
                    <SelectValue placeholder="Filter status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All ({statusCounts.all})</SelectItem>
                    <SelectItem value="trial">Trial ({statusCounts.trial})</SelectItem>
                    <SelectItem value="active">Active ({statusCounts.active})</SelectItem>
                    <SelectItem value="expired">Expired ({statusCounts.expired})</SelectItem>
                    <SelectItem value="expiring_soon">Expiring Soon ({statusCounts.expiring_soon})</SelectItem>
                    <SelectItem value="suspended">Suspended ({statusCounts.suspended})</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={countryFilter} onValueChange={setCountryFilter}>
                  <SelectTrigger className="w-full sm:w-44 text-xs sm:text-sm h-8 sm:h-9">
                    <Globe className="h-3 w-3 sm:h-4 sm:w-4 mr-1.5" />
                    <SelectValue placeholder="Country" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Countries</SelectItem>
                    {(isGlobalAccess ? countries : countries.filter(c => countryScopes.includes(c.code))).map(c => (
                      <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search organizations..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 text-xs sm:text-sm h-8 sm:h-9"
                  />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0 sm:pt-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 sm:h-8 sm:w-8 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {/* Mobile Card View */}
                <div className="sm:hidden space-y-2">
                  {filteredOrgs.length > 0 ? (
                    filteredOrgs.map((org) => {
                      const subscriptionInfo = getSubscriptionInfo(org);
                      const statusConfig = STATUS_CONFIG[subscriptionInfo.status] || STATUS_CONFIG.expired;
                      const StatusIcon = statusConfig.icon;

                      return (
                        <div key={org.id} className="border rounded-lg p-3 space-y-2.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-center gap-2.5 min-w-0">
                              <div className="h-8 w-8 shrink-0 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center overflow-hidden">
                                <Building2 className="h-3.5 w-3.5 text-primary" />
                              </div>
                              <div className="min-w-0">
                                <div className="font-medium text-sm truncate">{org.name}</div>
                                <Badge variant="outline" className="font-mono text-[10px] px-1.5 py-0">
                                  {org.slug}
                                </Badge>
                              </div>
                            </div>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => handleViewDetails(org)}>
                                  <Eye className="mr-2 h-4 w-4" />
                                  View Details
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => handleManageSubscription(org)}>
                                  <CreditCard className="mr-2 h-4 w-4" />
                                  Manage Subscription
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => handleSuspendOrg(org)}>
                                  {org.is_suspended ? (
                                    <><PlayCircle className="mr-2 h-4 w-4" />Unsuspend</>
                                  ) : (
                                    <><PauseCircle className="mr-2 h-4 w-4" />Suspend</>
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleOpenDelete(org)}>
                                  <Trash2 className="mr-2 h-4 w-4" />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          <div className="flex items-center flex-wrap gap-1.5">
                            <Badge className={`${statusConfig.color} border text-[10px] px-1.5 py-0`}>
                              <StatusIcon className="h-2.5 w-2.5 mr-0.5" />
                              {statusConfig.label}
                            </Badge>
                            {subscriptionInfo.daysRemaining !== null && (
                              <span className={`text-[10px] ${
                                subscriptionInfo.daysRemaining <= 0 ? 'text-destructive' : subscriptionInfo.isExpiringSoon ? 'text-yellow-600' : 'text-muted-foreground'
                              }`}>
                                {subscriptionInfo.daysRemaining <= 0 ? `Expired ${Math.abs(subscriptionInfo.daysRemaining)}d ago` : `${subscriptionInfo.daysRemaining}d left`}
                              </span>
                            )}
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-[11px]">
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <Users className="h-3 w-3 text-blue-500" />
                              <span>{org.memberCount}</span>
                            </div>
                            <div className="flex items-center gap-1 text-muted-foreground">
                              <FileText className="h-3 w-3 text-amber-500" />
                              <span>{org.invoiceCount}</span>
                            </div>
                            <div className="text-right font-medium text-green-600 truncate">
                              {formatCurrency(org.totalRevenue)}
                            </div>
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            Created {format(new Date(org.created_at), "MMM d, yyyy")}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-center text-muted-foreground py-12">
                      <Building2 className="h-10 w-10 mx-auto mb-2 opacity-20" />
                      <p className="text-sm">No organizations found</p>
                    </div>
                  )}
                </div>

                {/* Desktop Table View */}
                <div className="hidden sm:block rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50">
                        <TableHead className="text-xs">Organization</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-center text-xs">Members</TableHead>
                        <TableHead className="text-center text-xs">Invoices</TableHead>
                        <TableHead className="text-right text-xs">Revenue</TableHead>
                        <TableHead className="text-xs">Created</TableHead>
                        <TableHead className="w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredOrgs.length > 0 ? (
                        filteredOrgs.map((org) => {
                          const subscriptionInfo = getSubscriptionInfo(org);
                          const statusConfig = STATUS_CONFIG[subscriptionInfo.status] || STATUS_CONFIG.expired;
                          const StatusIcon = statusConfig.icon;

                          return (
                            <TableRow key={org.id}>
                              <TableCell>
                                <div className="flex items-center gap-3">
                                  <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center overflow-hidden">
                                    <Building2 className="h-4 w-4 text-primary" />
                                  </div>
                                  <div>
                                    <div className="font-medium text-sm">{org.name}</div>
                                    <Badge variant="outline" className="font-mono text-xs">
                                      {org.slug}
                                    </Badge>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col gap-1">
                                  <Badge className={`${statusConfig.color} border text-xs`}>
                                    <StatusIcon className="h-3 w-3 mr-1" />
                                    {statusConfig.label}
                                  </Badge>
                                  {subscriptionInfo.daysRemaining !== null && (
                                    <span className={`text-xs ${
                                      subscriptionInfo.daysRemaining <= 0 
                                        ? 'text-destructive' 
                                        : subscriptionInfo.isExpiringSoon 
                                          ? 'text-yellow-600' 
                                          : 'text-muted-foreground'
                                    }`}>
                                      {subscriptionInfo.daysRemaining <= 0 
                                        ? `Expired ${Math.abs(subscriptionInfo.daysRemaining)} days ago`
                                        : `${subscriptionInfo.daysRemaining} days left`
                                      }
                                    </span>
                                  )}
                                  {org.is_suspended && org.suspended_reason && (
                                    <span className="text-xs text-destructive truncate max-w-[150px]" title={org.suspended_reason}>
                                      {org.suspended_reason}
                                    </span>
                                  )}
                                  {org.scheduled_deletion_at && (
                                    <Badge variant="outline" className="border-destructive/50 text-destructive text-[10px] gap-1 w-fit">
                                      <CalendarClock className="h-2.5 w-2.5" />
                                      Purges {format(new Date(org.scheduled_deletion_at), "MMM d")}
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="text-center">
                                <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-blue-500/10 text-blue-600 text-sm">
                                  <Users className="h-3 w-3" />
                                  {org.memberCount}
                                </div>
                              </TableCell>
                              <TableCell className="text-center">
                                <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-500/10 text-amber-600 text-sm">
                                  <FileText className="h-3 w-3" />
                                  {org.invoiceCount}
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-medium text-green-600 text-sm">
                                {formatCurrency(org.totalRevenue)}
                              </TableCell>
                              <TableCell className="text-muted-foreground text-sm">
                                {format(new Date(org.created_at), "MMM d, yyyy")}
                              </TableCell>
                              <TableCell>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" size="icon" className="h-8 w-8">
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => handleViewDetails(org)}>
                                      <Eye className="mr-2 h-4 w-4" />
                                      View Details
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleManageSubscription(org)}>
                                      <CreditCard className="mr-2 h-4 w-4" />
                                      Manage Subscription
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => handleSuspendOrg(org)}>
                                      {org.is_suspended ? (
                                        <><PlayCircle className="mr-2 h-4 w-4" />Unsuspend Organization</>
                                      ) : (
                                        <><PauseCircle className="mr-2 h-4 w-4" />Suspend Organization</>
                                      )}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleScheduleDeletion(org)}>
                                      <CalendarClock className="mr-2 h-4 w-4" />
                                      {org.scheduled_deletion_at ? "Cancel Scheduled Deletion" : "Schedule Deletion (Grace Period)"}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleOpenDelete(org)}>
                                      <Trash2 className="mr-2 h-4 w-4" />
                                      Delete Immediately
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </TableCell>
                            </TableRow>
                          );
                        })
                      ) : (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-12">
                            <Building2 className="h-12 w-12 mx-auto mb-3 opacity-20" />
                            <p>No organizations found</p>
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Multi-Step Delete Dialog */}
      <MultiStepDeleteDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        entityName={selectedOrg?.name || ""}
        entityType="Organization"
        onConfirm={handleDeleteOrg}
        isDeleting={isDeleting}
      />




      {/* Suspend Organization Dialog */}
      <SuspendOrganizationDialog
        open={suspendDialogOpen}
        onOpenChange={setSuspendDialogOpen}
        organization={selectedOrg}
        onSuccess={fetchOrganizations}
      />

      {/* Schedule Deletion Dialog (grace-period workflow) */}
      <ScheduleDeletionDialog
        open={scheduleDeleteDialogOpen}
        onOpenChange={setScheduleDeleteDialogOpen}
        organization={selectedOrg}
        onSuccess={fetchOrganizations}
      />
    </>
  );
}

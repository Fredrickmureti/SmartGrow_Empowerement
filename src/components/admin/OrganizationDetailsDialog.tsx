// @ts-nocheck - Admin tables not in auto-generated types
import { OrgEntitlementOverrides } from "@/components/admin/OrgEntitlementOverrides";
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import {
  Building2,
  Users,
  FileText,
  DollarSign,
  Calendar,
  Mail,
  Globe,
  Loader2,
  CreditCard,
  Briefcase,
  MapPin,
  ChevronRight,
} from "lucide-react";
import { format } from "date-fns";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface OrganizationDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organization: {
    id: string;
    name: string;
    slug: string;
    email: string | null;
    base_currency: string | null;
    created_at: string;
    memberCount: number;
    invoiceCount: number;
    totalRevenue: number;
  } | null;
}

interface OrgMember {
  id: string;
  role: string;
  email: string;
  full_name: string | null;
}

interface Branch {
  id: string;
  name: string;
  code: string | null;
  is_headquarters: boolean;
  city: string | null;
}

interface Business {
  id: string;
  name: string;
  email: string | null;
  branches: Branch[];
}

export function OrganizationDetailsDialog({
  open,
  onOpenChange,
  organization,
}: OrganizationDetailsDialogProps) {
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [recentInvoices, setRecentInvoices] = useState<any[]>([]);
  const [expandedBusinesses, setExpandedBusinesses] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open && organization) {
      fetchDetails();
    }
  }, [open, organization]);

  const fetchDetails = async () => {
    if (!organization) return;
    setIsLoading(true);

    try {
      // Step 1: Fetch user_roles
      const { data: rolesData } = await (supabase.from as any)("user_roles")
        .select("id, user_id, role")
        .eq("organization_id", organization.id)
        .eq("is_active", true) as { data: any[] | null };

      // Step 2: Fetch profiles for those users
      const userIds = (rolesData || []).map(r => r.user_id);
      let profilesMap = new Map<string, { email: string; full_name: string | null }>();
      
      if (userIds.length > 0) {
        const { data: profilesData } = await (supabase.from as any)("profiles")
          .select("user_id, email, full_name")
          .in("user_id", userIds) as { data: any[] | null };
        
        profilesMap = new Map(
          (profilesData || []).map(p => [p.user_id, { email: p.email, full_name: p.full_name }])
        );
      }

      // Step 3: Merge data
      const membersList: OrgMember[] = (rolesData || []).map((r) => ({
        id: r.id,
        role: r.role,
        email: profilesMap.get(r.user_id)?.email || 'Unknown',
        full_name: profilesMap.get(r.user_id)?.full_name || null,
      }));
      setMembers(membersList);

      // Fetch recent invoices
      const { data: invoicesData } = await (supabase.from as any)("invoices")
        .select("id, invoice_number, total, status, created_at")
        .eq("organization_id", organization.id)
        .order("created_at", { ascending: false })
        .limit(5);

      setRecentInvoices(invoicesData || []);

      // Fetch businesses
      const { data: businessesData } = await (supabase.from as any)("businesses")
        .select("*")
        .eq("organization_id", organization.id)
        .eq("is_active", true)
        .order("name");

      const businessIds = (businessesData || []).map((b) => b.id);

      // Fetch branches for these businesses
      let branchesData: any[] = [];
      if (businessIds.length > 0) {
        const { data } = await (supabase.from as any)("branches")
          .select("*")
          .in("business_id", businessIds)
          .eq("is_active", true)
          .order("is_headquarters", { ascending: false })
          .order("name");
        branchesData = data || [];
      }

      // Build businesses with branches
      const businessesWithBranches = (businessesData || []).map((b) => ({
        id: b.id,
        name: b.name,
        email: b.email,
        branches: branchesData.filter((br) => br.business_id === b.id).map((br) => ({
          id: br.id,
          name: br.name,
          code: br.code,
          is_headquarters: br.is_headquarters,
          city: br.city,
        })),
      }));

      setBusinesses(businessesWithBranches);
      // Auto-expand all businesses
      setExpandedBusinesses(new Set(businessesWithBranches.map((b) => b.id)));
    } catch (error) {
      console.error("Error fetching org details:", error);
    } finally {
      setIsLoading(false);
    }
  };

  if (!organization) return null;

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: organization.base_currency || "USD", // architecture-allow: display-only fallback
      minimumFractionDigits: 0,
    }).format(amount);
  };

  const toggleBusiness = (businessId: string) => {
    const next = new Set(expandedBusinesses);
    if (next.has(businessId)) {
      next.delete(businessId);
    } else {
      next.add(businessId);
    }
    setExpandedBusinesses(next);
  };

  const totalBranches = businesses.reduce((sum, b) => sum + b.branches.length, 0);

  const roleLabels: Record<string, string> = {
    super_admin: "Super Admin",
    owner: "Owner",
    admin: "Admin",
    accountant: "Accountant",
    staff: "Staff",
    viewer: "Viewer",
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center overflow-hidden">
              <Building2 className="h-6 w-6 text-primary" />
            </div>
            <div>
              <DialogTitle className="text-xl">{organization.name}</DialogTitle>
              <Badge variant="outline" className="font-mono text-xs mt-1">
                {organization.slug}
              </Badge>
            </div>
          </div>
        </DialogHeader>

        <Separator />

        {/* Quick Stats */}
        <div className="grid grid-cols-4 gap-3">
          <div className="flex items-center gap-2.5 p-3 rounded-lg bg-muted/50">
            <Users className="h-5 w-5 text-blue-500" />
            <div>
              <p className="text-xl font-bold">{organization.memberCount}</p>
              <p className="text-xs text-muted-foreground">Members</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 p-3 rounded-lg bg-muted/50">
            <Briefcase className="h-5 w-5 text-purple-500" />
            <div>
              <p className="text-xl font-bold">{businesses.length}</p>
              <p className="text-xs text-muted-foreground">Businesses</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 p-3 rounded-lg bg-muted/50">
            <MapPin className="h-5 w-5 text-amber-500" />
            <div>
              <p className="text-xl font-bold">{totalBranches}</p>
              <p className="text-xs text-muted-foreground">Branches</p>
            </div>
          </div>
          <div className="flex items-center gap-2.5 p-3 rounded-lg bg-muted/50">
            <DollarSign className="h-5 w-5 text-green-500" />
            <div>
              <p className="text-lg font-bold text-green-600">
                {formatCurrency(organization.totalRevenue)}
              </p>
              <p className="text-xs text-muted-foreground">Revenue</p>
            </div>
          </div>
        </div>

        <Tabs defaultValue="structure" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="structure">Structure</TabsTrigger>
            <TabsTrigger value="info">Info</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
            <TabsTrigger value="overrides">Overrides</TabsTrigger>
          </TabsList>

          <TabsContent value="structure" className="mt-4">
            {isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : businesses.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Briefcase className="h-12 w-12 mx-auto mb-3 opacity-20" />
                <p>No businesses created yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {businesses.map((business) => (
                  <Collapsible
                    key={business.id}
                    open={expandedBusinesses.has(business.id)}
                    onOpenChange={() => toggleBusiness(business.id)}
                  >
                    <CollapsibleTrigger className="w-full">
                      <div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
                        <ChevronRight
                          className={cn(
                            "h-4 w-4 text-muted-foreground transition-transform",
                            expandedBusinesses.has(business.id) && "rotate-90"
                          )}
                        />
                        <div className="h-8 w-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                          <Briefcase className="h-4 w-4 text-blue-500" />
                        </div>
                        <div className="flex-1 text-left">
                          <p className="font-medium">{business.name}</p>
                          <p className="text-xs text-muted-foreground">
                            {business.branches.length} branch{business.branches.length !== 1 ? "es" : ""}
                          </p>
                        </div>
                      </div>
                    </CollapsibleTrigger>

                    <CollapsibleContent>
                      <div className="ml-6 mt-2 space-y-1.5 border-l-2 border-muted pl-4">
                        {business.branches.length === 0 ? (
                          <p className="text-sm text-muted-foreground py-2">
                            No branches created
                          </p>
                        ) : (
                          business.branches.map((branch) => (
                            <div
                              key={branch.id}
                              className="flex items-center gap-2.5 p-2.5 rounded-md bg-muted/30"
                            >
                              <div className="h-6 w-6 rounded bg-amber-500/10 flex items-center justify-center">
                                <MapPin className="h-3 w-3 text-amber-500" />
                              </div>
                              <div className="flex-1">
                                <p className="text-sm font-medium flex items-center gap-2">
                                  {branch.name}
                                  {branch.is_headquarters && (
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                      HQ
                                    </Badge>
                                  )}
                                </p>
                                {(branch.code || branch.city) && (
                                  <p className="text-xs text-muted-foreground">
                                    {[branch.code, branch.city].filter(Boolean).join(" • ")}
                                  </p>
                                )}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="info" className="space-y-4 mt-4">
            <div className="grid gap-3">
              <div className="flex items-center gap-3">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <div className="text-sm">
                  {(() => {
                    const owner = members.find(m => m.role === "owner");
                    return owner ? (
                      <span className="flex items-center gap-1.5">
                        {owner.email}
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          owner's email
                        </Badge>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">No email set</span>
                    );
                  })()}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">
                  Currency: {organization.base_currency || "USD"} // architecture-allow: display-only fallback
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Calendar className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">
                  Created: {format(new Date(organization.created_at), "MMMM d, yyyy")}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <CreditCard className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">
                  Subscription: <Badge variant="secondary">Active</Badge>
                </span>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="members" className="mt-4">
            {isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-2">
                {members.map((member) => (
                  <div
                    key={member.id}
                    className="flex items-center justify-between p-3 rounded-lg border"
                  >
                    <div>
                      <p className="font-medium">
                        {member.full_name || member.email}
                      </p>
                      {member.full_name && (
                        <p className="text-sm text-muted-foreground">
                          {member.email}
                        </p>
                      )}
                    </div>
                    <Badge variant="outline">
                      {roleLabels[member.role] || member.role}
                    </Badge>
                  </div>
                ))}
                {members.length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No members found
                  </p>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="invoices" className="mt-4">
            {isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <div className="space-y-2">
                {recentInvoices.map((invoice) => (
                  <div
                    key={invoice.id}
                    className="flex items-center justify-between p-3 rounded-lg border"
                  >
                    <div>
                      <p className="font-medium font-mono">
                        {invoice.invoice_number}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {format(new Date(invoice.created_at), "MMM d, yyyy")}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">
                        {formatCurrency(invoice.total)}
                      </p>
                      <Badge
                        variant={
                          invoice.status === "paid"
                            ? "default"
                            : invoice.status === "overdue"
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {invoice.status}
                      </Badge>
                    </div>
                  </div>
                ))}
                {recentInvoices.length === 0 && (
                  <p className="text-center text-muted-foreground py-8">
                    No invoices found
                  </p>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="overrides" className="mt-4">
            {organization && (
              <OrgEntitlementOverrides
                organizationId={organization.id}
                organizationName={organization.name}
              />
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

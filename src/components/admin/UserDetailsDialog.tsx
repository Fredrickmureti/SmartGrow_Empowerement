// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { supabase } from "@/integrations/supabase/client";
import {
  Building2,
  Briefcase,
  MapPin,
  Calendar,
  Mail,
  Loader2,
  ChevronRight,
  User,
  Shield,
} from "lucide-react";
import { format } from "date-fns";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface UserDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: {
    id: string;
    user_id: string;
    email: string;
    full_name: string | null;
    created_at: string;
    isPlatformAdmin: boolean;
  } | null;
}

interface Business {
  id: string;
  name: string;
  email: string | null;
  is_active: boolean;
  branches: Branch[];
}

interface Branch {
  id: string;
  name: string;
  code: string | null;
  is_headquarters: boolean;
  city: string | null;
}

interface OrganizationHierarchy {
  id: string;
  name: string;
  slug: string;
  role: string;
  created_at: string;
  businesses: Business[];
}

export function UserDetailsDialog({
  open,
  onOpenChange,
  user,
}: UserDetailsDialogProps) {
  const [organizations, setOrganizations] = useState<OrganizationHierarchy[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());
  const [expandedBusinesses, setExpandedBusinesses] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (open && user) {
      fetchUserHierarchy();
    }
  }, [open, user]);

  const fetchUserHierarchy = async () => {
    if (!user) return;
    setIsLoading(true);

    try {
      // Fetch all user roles with organization details
      const { data: rolesData, error: rolesError } = await supabase
        .from("user_roles")
        .select(`
          role,
          organization_id,
          organizations (
            id,
            name,
            slug,
            created_at
          )
        `)
        .eq("user_id", user.user_id)
        .eq("is_active", true);

      if (rolesError) throw rolesError;

      const orgIds = rolesData?.map((r: any) => r.organization_id) || [];

      // Fetch all businesses for these organizations
      let businessesData: any[] = [];
      if (orgIds.length > 0) {
        const { data, error } = await supabase
          .from("businesses")
          .select("*")
          .in("organization_id", orgIds)
          .eq("is_active", true)
          .order("name");

        if (!error) businessesData = data || [];
      }

      // Fetch all branches for these businesses
      const businessIds = businessesData.map((b) => b.id);
      let branchesData: any[] = [];
      if (businessIds.length > 0) {
        const { data, error } = await supabase
          .from("branches")
          .select("*")
          .in("business_id", businessIds)
          .eq("is_active", true)
          .order("is_headquarters", { ascending: false })
          .order("name");

        if (!error) branchesData = data || [];
      }

      // Build the hierarchy
      const hierarchy: OrganizationHierarchy[] = (rolesData || []).map((r: any) => {
        const org = r.organizations;
        const orgBusinesses = businessesData.filter((b) => b.organization_id === org.id);
        
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          role: r.role,
          created_at: org.created_at,
          businesses: orgBusinesses.map((b) => ({
            id: b.id,
            name: b.name,
            email: b.email,
            is_active: b.is_active,
            branches: branchesData.filter((br) => br.business_id === b.id).map((br) => ({
              id: br.id,
              name: br.name,
              code: br.code,
              is_headquarters: br.is_headquarters,
              city: br.city,
            })),
          })),
        };
      });

      setOrganizations(hierarchy);
      // Auto-expand all orgs initially
      setExpandedOrgs(new Set(hierarchy.map((o) => o.id)));
    } catch (error) {
      console.error("Error fetching user hierarchy:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleOrg = (orgId: string) => {
    const next = new Set(expandedOrgs);
    if (next.has(orgId)) {
      next.delete(orgId);
    } else {
      next.add(orgId);
    }
    setExpandedOrgs(next);
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

  const roleLabels: Record<string, string> = {
    super_admin: "Super Admin",
    owner: "Owner",
    admin: "Admin",
    accountant: "Accountant",
    staff: "Staff",
    viewer: "Viewer",
  };

  const getRoleBadgeVariant = (role: string) => {
    switch (role) {
      case "owner":
      case "super_admin":
        return "default";
      case "admin":
        return "secondary";
      default:
        return "outline";
    }
  };

  if (!user) return null;

  const totalBusinesses = organizations.reduce((sum, o) => sum + o.businesses.length, 0);
  const totalBranches = organizations.reduce(
    (sum, o) => sum + o.businesses.reduce((bSum, b) => bSum + b.branches.length, 0),
    0
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <Avatar className="h-10 w-10 sm:h-14 sm:w-14 shrink-0">
              <AvatarFallback className="bg-primary/10 text-primary text-sm sm:text-lg">
                {user.email.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base sm:text-xl flex flex-wrap items-center gap-2">
                <span className="truncate">{user.full_name || user.email}</span>
                {user.isPlatformAdmin && (
                  <Badge className="bg-primary/10 text-primary border-primary/20 shrink-0">
                    <Shield className="mr-1 h-3 w-3" />
                    Platform Admin
                  </Badge>
                )}
              </DialogTitle>
              <p className="text-xs sm:text-sm text-muted-foreground flex items-center gap-1.5 mt-1 truncate">
                <Mail className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{user.email}</span>
              </p>
            </div>
          </div>
        </DialogHeader>

        <Separator />

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-2 sm:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg bg-muted/50">
            <Building2 className="h-4 w-4 sm:h-5 sm:w-5 text-primary shrink-0" />
            <div className="min-w-0">
              <p className="text-lg sm:text-2xl font-bold">{organizations.length}</p>
              <p className="text-[10px] sm:text-xs text-muted-foreground truncate">Organizations</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg bg-muted/50">
            <Briefcase className="h-4 w-4 sm:h-5 sm:w-5 text-blue-500 shrink-0" />
            <div className="min-w-0">
              <p className="text-lg sm:text-2xl font-bold">{totalBusinesses}</p>
              <p className="text-[10px] sm:text-xs text-muted-foreground truncate">Businesses</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 p-2 sm:p-3 rounded-lg bg-muted/50">
            <MapPin className="h-4 w-4 sm:h-5 sm:w-5 text-amber-500 shrink-0" />
            <div className="min-w-0">
              <p className="text-lg sm:text-2xl font-bold">{totalBranches}</p>
              <p className="text-[10px] sm:text-xs text-muted-foreground truncate">Branches</p>
            </div>
          </div>
        </div>

        {/* User Info */}
        <div className="flex items-center gap-3 text-xs sm:text-sm text-muted-foreground">
          <Calendar className="h-4 w-4 shrink-0" />
          <span>Joined {format(new Date(user.created_at), "MMMM d, yyyy")}</span>
        </div>

        <Separator />

        {/* Organization Hierarchy */}
        <div className="space-y-2">
          <h3 className="font-semibold flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Organization Hierarchy
          </h3>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : organizations.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <User className="h-12 w-12 mx-auto mb-3 opacity-20" />
              <p>This user has no organizations</p>
            </div>
          ) : (
            <div className="space-y-3">
              {organizations.map((org) => (
                <Collapsible
                  key={org.id}
                  open={expandedOrgs.has(org.id)}
                  onOpenChange={() => toggleOrg(org.id)}
                >
                  <CollapsibleTrigger className="w-full">
                    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
                      <ChevronRight
                        className={cn(
                          "h-4 w-4 text-muted-foreground transition-transform",
                          expandedOrgs.has(org.id) && "rotate-90"
                        )}
                      />
                      <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                        <Building2 className="h-4 w-4 text-primary" />
                      </div>
                      <div className="flex-1 text-left">
                        <p className="font-medium">{org.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {org.businesses.length} business{org.businesses.length !== 1 ? "es" : ""}
                        </p>
                      </div>
                      <Badge variant={getRoleBadgeVariant(org.role)}>
                        {roleLabels[org.role] || org.role}
                      </Badge>
                    </div>
                  </CollapsibleTrigger>

                  <CollapsibleContent>
                    <div className="ml-6 mt-2 space-y-2 border-l-2 border-muted pl-4">
                      {org.businesses.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-2">
                          No businesses created
                        </p>
                      ) : (
                        org.businesses.map((business) => (
                          <Collapsible
                            key={business.id}
                            open={expandedBusinesses.has(business.id)}
                            onOpenChange={() => toggleBusiness(business.id)}
                          >
                            <CollapsibleTrigger className="w-full">
                              <div className="flex items-center gap-3 p-2.5 rounded-lg border bg-card/50 hover:bg-muted/30 transition-colors">
                                <ChevronRight
                                  className={cn(
                                    "h-3.5 w-3.5 text-muted-foreground transition-transform",
                                    expandedBusinesses.has(business.id) && "rotate-90"
                                  )}
                                />
                                <div className="h-7 w-7 rounded-md bg-blue-500/10 flex items-center justify-center">
                                  <Briefcase className="h-3.5 w-3.5 text-blue-500" />
                                </div>
                                <div className="flex-1 text-left">
                                  <p className="text-sm font-medium">{business.name}</p>
                                  <p className="text-xs text-muted-foreground">
                                    {business.branches.length} branch{business.branches.length !== 1 ? "es" : ""}
                                  </p>
                                </div>
                              </div>
                            </CollapsibleTrigger>

                            <CollapsibleContent>
                              <div className="ml-5 mt-1.5 space-y-1 border-l border-muted pl-3">
                                {business.branches.length === 0 ? (
                                  <p className="text-xs text-muted-foreground py-1.5">
                                    No branches created
                                  </p>
                                ) : (
                                  business.branches.map((branch) => (
                                    <div
                                      key={branch.id}
                                      className="flex items-center gap-2.5 p-2 rounded-md bg-muted/30"
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
                        ))
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
